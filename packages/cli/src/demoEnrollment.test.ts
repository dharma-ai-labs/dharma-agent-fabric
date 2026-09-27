import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { connectDemoDevice, loadDemoSigningTrust, scopePath, verifyDemoDevice } from './demoEnrollment.js';
import { run } from './index.js';

const orgId = 'org_fixture';
const repositoryId = '10000000-0000-4000-8000-000000000001';
const deviceId = '30000000-0000-4000-8000-000000000001';
const grant = 'A'.repeat(43);
const deviceCode = 'B'.repeat(43);
const browserCode = 'ABCDEF0123456789ABCD';
const normalizedRepository = 'github.com/example/private';
const hqUrl = 'https://dharma.example';
const signer = generateKeyPairSync('ed25519');
const serverPublicKeyEd25519 = (signer.publicKey.export({ format: 'jwk' }) as { x?: string }).x!;

function approvedEnrollment() {
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const keyVersion = 'projects/test/locations/global/keyRings/demo/cryptoKeys/signing/cryptoKeyVersions/1';
  const keyset = { schema: 'dharma.server-signing-keyset/v1' as const,
    organizationId: orgId, generation: 1, keys: [{ keyVersion,
      publicKeyEd25519: serverPublicKeyEd25519, status: 'active' as const,
      notBefore: issuedAt, notAfter: expiresAt }], signedByKeyVersion: keyVersion,
    issuedAt, expiresAt };
  return { ok: true, status: 'approved', deviceId, repositoryId, serverPublicKeyEd25519,
    serverSigningKeyset: { ...keyset, signature: signCanonicalObject(keyset, signer.privateKey) } };
}

function memoryStore(): SecureSecretStore {
  const values = new Map<string, string>();
  return { backend: 'linux-secret-service',
    async get(account) { return values.get(account) || null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); } };
}

function options(stateRoot: string) {
  return { hqUrl, organizationId: orgId, repositoryId, normalizedRepository,
    grant, deviceName: 'Fixture laptop', platform: 'linux' as const,
    installationId: '40000000-0000-4000-8000-000000000001',
    stateRoot, maximumWaitMs: 1_000 };
}

test('Demo enrollment verifies the browser origin, waits for approval and signs a scoped status request', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-cli-'));
  const calls: string[] = [];
  let publicKey = '';
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    calls.push(url.pathname);
    if (url.pathname.endsWith('/enrollments')) {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      assert.equal(body.grant, grant);
      assert.equal(body.repositoryId, repositoryId);
      publicKey = body.publicKeyEd25519!;
      return new Response(JSON.stringify({ ok: true, status: 'pending', organizationId: orgId,
        repositoryId, deviceCode, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
      { status: 202 });
    }
    if (url.pathname.endsWith('/poll')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { orgId, deviceCode });
      return new Response(JSON.stringify(approvedEnrollment()), { status: 200 });
    }
    assert.equal(url.pathname,
      `/api/demo/fabric/repositories/${repositoryId}/status`);
    const headers = new Headers(init?.headers);
    const signingPayload = Buffer.from(JSON.stringify({
      bodyHash: `sha256:${createHash('sha256').update('').digest('hex')}`,
      deviceId,
      messageId: headers.get('x-dharma-message-id'),
      method: 'GET',
      nonce: headers.get('x-dharma-nonce'),
      organizationId: orgId,
      pathname: `${url.pathname}${url.search}`,
      sequence: Number(headers.get('x-dharma-sequence')),
      sessionId: headers.get('x-dharma-session-id'),
      timestamp: headers.get('x-dharma-timestamp'),
    }));
    assert.equal(verify(null, signingPayload,
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }),
      Buffer.from(headers.get('x-dharma-signature')!, 'base64url')), true);
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository }), { status: 200 });
  };
  const approvals: string[] = [];
  const store = memoryStore();
  const connected = await connectDemoDevice(options(stateRoot), {
    store, fetcher, sleep: async () => {},
    onApprovalRequired: async (url) => { approvals.push(url); },
  });
  assert.equal(connected.stage, 'device_signed_ready');
  assert.equal(connected.deviceId, deviceId);
  assert.deepEqual(calls, ['/api/demo/fabric/enrollments',
    '/api/demo/fabric/enrollments/poll', `/api/demo/fabric/repositories/${repositoryId}/status`]);
  assert.equal(approvals.length, 1);
  assert.equal(new URL(approvals[0]!).origin, hqUrl);
  const config = JSON.parse(await readFile(connected.configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(config.deviceId, deviceId);
  assert.equal(config.grant, undefined);
  assert.equal(config.privateKey, undefined);
  assert.equal((await loadDemoSigningTrust(options(stateRoot), { store })).deviceId, deviceId);
  if (process.platform !== 'win32') assert.equal((await stat(connected.configPath)).mode & 0o777, 0o600);
});

test('Demo enrollment rejects missing and foreign signing anchors before saving a device', async () => {
  for (const response of [
    { ok: true, status: 'approved', deviceId, repositoryId },
    { ...approvedEnrollment(), serverPublicKeyEd25519: 'A'.repeat(43) },
  ]) {
    const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-trust-reject-'));
    const fetcher: typeof fetch = async (resource) => {
      const pathname = new URL(String(resource)).pathname;
      if (pathname.endsWith('/enrollments')) return new Response(JSON.stringify({ ok: true,
        status: 'pending', organizationId: orgId, repositoryId, deviceCode,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
      { status: 202 });
      return new Response(JSON.stringify(response), { status: 200 });
    };
    await assert.rejects(connectDemoDevice(options(stateRoot), { store: memoryStore(), fetcher }),
      /signing trust|untrusted_initial_signer/i);
    await assert.rejects(readFile(scopePath(options(stateRoot), hqUrl)), { code: 'ENOENT' });
  }
});

test('fresh enrollment during preload protects the successor before status and resumes activation after restart', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-preload-enrollment-'));
  const scope = options(stateRoot);
  const store = memoryStore();
  const approved = approvedEnrollment();
  const initial = approved.serverSigningKeyset;
  const successor = generateKeyPairSync('ed25519');
  const nextExpiry = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
  const { signature: _signature, ...initialUnsigned } = initial;
  const preloadUnsigned = { ...initialUnsigned, generation: 2, keys: [...initial.keys, {
    keyVersion: 'successor', publicKeyEd25519: successor.publicKey.export({ format: 'jwk' }).x!,
    status: 'overlap' as const, notBefore: initial.issuedAt, notAfter: nextExpiry }] };
  const preload = { ...preloadUnsigned, signature: signCanonicalObject(preloadUnsigned, signer.privateKey) };
  const activeUnsigned = { ...preloadUnsigned, generation: 3, signedByKeyVersion: 'successor',
    expiresAt: nextExpiry, keys: preload.keys.map(key => ({ ...key,
      status: key.keyVersion === 'successor' ? 'active' as const : 'overlap' as const })) };
  const active = { ...activeUnsigned, signature: signCanonicalObject(activeUnsigned, successor.privateKey) };
  const envelope = (keysets: unknown[]) => ({ schema: 'dharma.demo-signing-update/v1',
    organizationId: orgId, repositoryId, deviceId, issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), keysets });
  let activate = false;
  const fetcher: typeof fetch = async (resource) => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/enrollments')) return new Response(JSON.stringify({ ok: true,
      status: 'pending', organizationId: orgId, repositoryId, deviceCode,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }));
    if (url.pathname.endsWith('/poll')) return new Response(JSON.stringify({ ...approved,
      signingTrustUpdate: envelope([initial, preload]) }));
    assert.equal(url.searchParams.get('signingGeneration'), '2');
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository, ...(activate ? { signingTrustUpdate: envelope([preload, active]) } : {}) }));
  };
  const connected = await connectDemoDevice(scope, { store, fetcher });
  assert.equal((await loadDemoSigningTrust(scope, { store })).keyset.generation, 2);
  // The same approved enrollment may be returned on retry; it must not downgrade protected trust.
  await connectDemoDevice(scope, { store, fetcher });
  activate = true;
  await verifyDemoDevice(scope, { store, fetcher });
  const trust = await loadDemoSigningTrust(scope, { store,
    now: new Date(Date.parse(initial.expiresAt) + 1_000) });
  assert.equal(trust.keyset.generation, 3);
  const saved = await readFile(connected.configPath, 'utf8');
  assert.doesNotMatch(saved, /grant|signingTrustUpdate|privateKey|privateJwk/i);
  assert.equal(JSON.parse(saved).serverPublicKeyEd25519, serverPublicKeyEd25519);
});

test('fresh enrollment rejects a foreign or corrupt preload before writing a device or requesting signed status', async () => {
  for (const fault of ['foreign', 'corrupt', 'expired', 'unexpected']) {
    const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-preload-reject-'));
    const scope = options(stateRoot);
    const approved = approvedEnrollment();
    const update = { schema: 'dharma.demo-signing-update/v1', organizationId: orgId,
      repositoryId, deviceId, issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), keysets: [approved.serverSigningKeyset],
      ...(fault === 'unexpected' ? { grant: 'must-not-persist' } : {}) };
    if (fault === 'foreign') update.deviceId = '30000000-0000-4000-8000-000000000099';
    if (fault === 'expired') update.expiresAt = new Date(Date.now() - 1_000).toISOString();
    if (fault === 'corrupt') update.keysets = [{ ...approved.serverSigningKeyset, generation: 2, signature: 'invalid' }];
    const fetcher: typeof fetch = async (resource) => {
      const pathname = new URL(String(resource)).pathname;
      if (pathname.endsWith('/enrollments')) return new Response(JSON.stringify({ ok: true,
        status: 'pending', organizationId: orgId, repositoryId, deviceCode,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }));
      assert.ok(pathname.endsWith('/poll'), 'a rejected preload must never dispatch signed status');
      return new Response(JSON.stringify({ ...approved, signingTrustUpdate: update }));
    };
    await assert.rejects(connectDemoDevice(scope, { store: memoryStore(), fetcher }), /Demo signing/);
    await assert.rejects(readFile(scopePath(scope, hqUrl)), { code: 'ENOENT' });
  }
});

test('interrupted preload enrollment recovers its protected binding without a second approval or credential file', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-preload-interrupt-'));
  const scope = options(stateRoot);
  const store = memoryStore();
  const approved = approvedEnrollment();
  const initial = approved.serverSigningKeyset;
  const successor = generateKeyPairSync('ed25519');
  const { signature: _signature, ...body } = initial;
  const unsigned = { ...body, generation: 2, keys: [...initial.keys, { keyVersion: 'successor',
    publicKeyEd25519: successor.publicKey.export({ format: 'jwk' }).x!, status: 'overlap' as const,
    notBefore: initial.issuedAt, notAfter: new Date(Date.now() + 48 * 60 * 60_000).toISOString() }] };
  const preload = { ...unsigned, signature: signCanonicalObject(unsigned, signer.privateKey) };
  const fetcher: typeof fetch = async (resource) => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/enrollments')) return new Response(JSON.stringify({ ok: true,
      status: 'approved', organizationId: orgId, repositoryId, deviceCode,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }));
    if (url.pathname.endsWith('/poll')) return new Response(JSON.stringify({ ...approved, signingTrustUpdate: {
      schema: 'dharma.demo-signing-update/v1', organizationId: orgId, repositoryId, deviceId,
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), keysets: [initial, preload] } }));
    assert.equal(url.searchParams.get('signingGeneration'), '2');
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId, deviceId, normalizedRepository }));
  };
  const interruptedStore: SecureSecretStore = { ...store, async put(account, value) {
    await store.put(account, value);
    if (account.startsWith('demo-signing-') && JSON.parse(value).serverSigningKeyset.generation === 2) {
      throw new Error('simulated termination after protected write');
    }
  } };
  await assert.rejects(connectDemoDevice(scope, { store: interruptedStore, fetcher }), /simulated termination/);
  const path = scopePath(scope, hqUrl);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  const pending = JSON.parse(await readFile(`${path}.pending-enrollment.json`, 'utf8'));
  assert.equal(pending.signedReady, false);
  assert.doesNotMatch(JSON.stringify(pending), /grant|privateKey|privateJwk|signingTrustUpdate/i);
  for (const change of [{ organizationId: 'org_foreign' }, { publicKeyEd25519: 'E'.repeat(43) },
    { deviceId: '30000000-0000-4000-8000-000000000099' }, { signedReady: true }, { nextSequence: 2 },
    { grant: 'must-not-persist' }]) {
    const foreign = JSON.stringify({ ...pending, ...change });
    await writeFile(`${path}.pending-enrollment.json`, foreign);
    await assert.rejects(connectDemoDevice(scope, { store, fetcher }), /Pending Demo enrollment/);
    assert.equal(await readFile(`${path}.pending-enrollment.json`, 'utf8'), foreign);
  }
  await writeFile(`${path}.pending-enrollment.json`, JSON.stringify(pending));
  await new Promise(accept => setTimeout(accept, 10));
  const result = await connectDemoDevice(scope, { store, fetcher,
    onApprovalRequired: async () => { assert.fail('an approved interrupted enrollment must not ask for another approval'); } });
  assert.equal(result.stage, 'device_signed_ready');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).enrolledAt, pending.enrolledAt);
  assert.equal((await loadDemoSigningTrust(scope, { store })).keyset.generation, 2);
  await assert.rejects(readFile(`${path}.pending-enrollment.json`), { code: 'ENOENT' });
});

test('signed status autonomously accepts a successor and reloads it from protected trust after bootstrap expiry', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-rotation-'));
  const scope = options(stateRoot);
  const store = memoryStore();
  const approved = approvedEnrollment();
  const initial = approved.serverSigningKeyset;
  const successor = generateKeyPairSync('ed25519');
  const nextExpiry = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
  const preloadBody = { ...initial, generation: 2, keys: [...initial.keys, {
    keyVersion: 'successor', publicKeyEd25519: successor.publicKey.export({ format: 'jwk' }).x!,
    status: 'overlap' as const, notBefore: initial.issuedAt, notAfter: nextExpiry }] };
  const { signature: _oldSignature, ...preloadUnsigned } = preloadBody;
  const preload = { ...preloadUnsigned, signature: signCanonicalObject(preloadUnsigned, signer.privateKey) };
  const activeUnsigned = { ...preloadUnsigned, generation: 3, signedByKeyVersion: 'successor',
    expiresAt: nextExpiry, keys: preload.keys.map(key => ({ ...key,
      status: key.keyVersion === 'successor' ? 'active' as const : 'overlap' as const })) };
  const active = { ...activeUnsigned, signature: signCanonicalObject(activeUnsigned, successor.privateKey) };
  let update: unknown;
  const fetcher: typeof fetch = async (resource) => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/enrollments')) return new Response(JSON.stringify({ ok: true,
      status: 'pending', organizationId: orgId, repositoryId, deviceCode,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }));
    if (url.pathname.endsWith('/poll')) return new Response(JSON.stringify(approved));
    assert.equal(url.searchParams.get('signingGeneration'), '1');
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository, ...(update ? { signingTrustUpdate: update } : {}) }));
  };
  const connected = await connectDemoDevice(scope, { store, fetcher });
  update = { schema: 'dharma.demo-signing-update/v1', organizationId: orgId, repositoryId, deviceId,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    keysets: [preload, active] };
  await verifyDemoDevice(scope, { store, fetcher });
  const trusted = await loadDemoSigningTrust(scope, { store,
    now: new Date(Date.parse(initial.expiresAt) + 1_000) });
  assert.equal(trusted.keyset.generation, 3);
  const config = JSON.parse(await readFile(connected.configPath, 'utf8'));
  assert.equal(config.serverPublicKeyEd25519, approved.serverPublicKeyEd25519);
  assert.equal(config.serverSigningKeyset.keys[0].notAfter, initial.keys[0]!.notAfter);
  assert.equal(config.nextSequence, 3);
  assert.doesNotMatch(JSON.stringify(config), /grant|privateJwk|privateKey/i);
});

test('a rejected status trust update preserves the sequence and last verified keyset', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-rotation-reject-'));
  const scope = options(stateRoot);
  const store = memoryStore();
  const approved = approvedEnrollment();
  let tamper = false;
  const fetcher: typeof fetch = async (resource) => {
    const pathname = new URL(String(resource)).pathname;
    if (pathname.endsWith('/enrollments')) return new Response(JSON.stringify({ ok: true,
      status: 'pending', organizationId: orgId, repositoryId, deviceCode,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }));
    if (pathname.endsWith('/poll')) return new Response(JSON.stringify(approved));
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository, ...(tamper ? { signingTrustUpdate: {
        schema: 'dharma.demo-signing-update/v1', organizationId: orgId, repositoryId, deviceId,
        issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        keysets: [{ ...approved.serverSigningKeyset, generation: 2, signature: 'invalid' }] } } : {}) }));
  };
  const connected = await connectDemoDevice(scope, { store, fetcher });
  tamper = true;
  await assert.rejects(verifyDemoDevice(scope, { store, fetcher }), /Demo signing/);
  const config = JSON.parse(await readFile(connected.configPath, 'utf8'));
  assert.equal(config.nextSequence, 3);
  assert.equal(config.serverSigningKeyset.generation, 1);
  assert.deepEqual((await loadDemoSigningTrust(scope, { store })).keyset, approved.serverSigningKeyset);
  tamper = false;
  await verifyDemoDevice(scope, { store, fetcher });
  assert.equal(JSON.parse(await readFile(connected.configPath, 'utf8')).nextSequence, 4);
});

test('Demo enrollment recovers from one transient poll failure without restarting enrollment', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-poll-retry-'));
  const calls: string[] = [];
  const fetcher: typeof fetch = async (resource) => {
    const pathname = new URL(String(resource)).pathname;
    calls.push(pathname);
    if (pathname.endsWith('/enrollments')) {
      return new Response(JSON.stringify({ ok: true, status: 'pending', organizationId: orgId,
        repositoryId, deviceCode, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
      { status: 202 });
    }
    if (pathname.endsWith('/poll')) {
      if (calls.filter((path) => path.endsWith('/poll')).length === 1) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'internal_error',
          message: 'Temporary database failure.' } }), { status: 500 });
      }
      return new Response(JSON.stringify(approvedEnrollment()),
        { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository }), { status: 200 });
  };
  const connected = await connectDemoDevice(options(stateRoot), {
    store: memoryStore(), fetcher, sleep: async () => {},
  });
  assert.equal(connected.stage, 'device_signed_ready');
  assert.equal(calls.filter((path) => path.endsWith('/enrollments')).length, 1);
  assert.equal(calls.filter((path) => path.endsWith('/poll')).length, 2);
});

test('Demo enrollment bounds repeated transient poll failures and stops on authorization errors', async () => {
  for (const pollStatus of [500, 403]) {
    const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-poll-failure-'));
    let polls = 0;
    const fetcher: typeof fetch = async (resource) => {
      const pathname = new URL(String(resource)).pathname;
      if (pathname.endsWith('/enrollments')) {
        return new Response(JSON.stringify({ ok: true, status: 'pending', organizationId: orgId,
          repositoryId, deviceCode, expiresAt: new Date(Date.now() + 60_000).toISOString(),
          verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
        { status: 202 });
      }
      polls += 1;
      return new Response(JSON.stringify({ ok: false, error: { code: pollStatus === 500
        ? 'internal_error' : 'demo_fabric_membership_required', message: 'Unavailable.' } }),
      { status: pollStatus });
    };
    await assert.rejects(connectDemoDevice(options(stateRoot), {
      store: memoryStore(), fetcher, sleep: async () => {},
    }), pollStatus === 500 ? /polling failed after 3 transient attempts/i
      : /demo_fabric_membership_required/);
    assert.equal(polls, pollStatus === 500 ? 3 : 1);
  }
});

test('Demo enrollment rejects an off-origin approval link before opening a browser or saving a device', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-cli-invalid-'));
  let opened = false;
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ ok: true, status: 'pending',
    organizationId: orgId, repositoryId, deviceCode,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    verificationUri: `https://attacker.example/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
  { status: 202 });
  await assert.rejects(connectDemoDevice(options(stateRoot), { store: memoryStore(), fetcher,
    onApprovalRequired: async () => { opened = true; } }), /verification origin/i);
  assert.equal(opened, false);
});

test('Demo command dry-run verifies the local repository without a grant or device write', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-demo-repo-'));
  const home = await mkdtemp(resolve(tmpdir(), 'dharma-demo-home-'));
  execFileSync('git', ['init', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'git@github.com:Example/Private.git']);
  const previous = process.env.DHARMA_HOME;
  process.env.DHARMA_HOME = home;
  try {
    const receipt = await run(['demo', 'connect', '--dry-run', '--workspace', root,
      '--portal-url', hqUrl, '--organization-id', orgId,
      '--repository-id', repositoryId, '--normalized-repository', normalizedRepository]);
    assert.equal((receipt as { stage: string }).stage, 'demo_device_plan');
    for (const command of ['status', 'role', 'peers', 'ask', 'reply', 'inbox', 'ack', 'resume']) {
      const peerPlan = await run(['demo', command, '--dry-run', '--workspace', root,
        '--portal-url', hqUrl, '--organization-id', orgId,
        '--repository-id', repositoryId, '--normalized-repository', normalizedRepository]);
      assert.equal((peerPlan as { stage: string }).stage, 'demo_device_plan');
    }
    await assert.rejects(stat(resolve(home, 'installation.json')), { code: 'ENOENT' });
    await assert.rejects(run(['demo', 'connect', '--dry-run', '--workspace', root,
      '--portal-url', hqUrl, '--organization-id', orgId,
      '--repository-id', repositoryId, '--normalized-repository', 'github.com/other/repo']),
    /does not match/);
  } finally {
    if (previous === undefined) delete process.env.DHARMA_HOME;
    else process.env.DHARMA_HOME = previous;
  }
});

test('lost status response resumes grant-free with exact replay, then retries an unseen expired sequence', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-recovery-'));
  const store = memoryStore();
  const signed: Headers[] = [];
  let loseResponse = true;
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/enrollments')) {
      return new Response(JSON.stringify({ ok: true, status: 'pending', organizationId: orgId,
        repositoryId, deviceCode, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
      { status: 202 });
    }
    if (url.pathname.endsWith('/poll')) {
      return new Response(JSON.stringify(approvedEnrollment()),
        { status: 200 });
    }
    signed.push(new Headers(init?.headers));
    if (loseResponse) { loseResponse = false; throw new Error('connection lost after dispatch'); }
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository, duplicate: signed.length === 2 }), { status: 200 });
  };
  await assert.rejects(connectDemoDevice(options(stateRoot), { store, fetcher }),
    /connection lost/);
  const directory = resolve(stateRoot, 'demo', (await readdir(resolve(stateRoot, 'demo')))[0]!);
  const configPath = resolve(directory, 'device.json');
  assert.equal((JSON.parse(await readFile(configPath, 'utf8')) as { signedReady: boolean }).signedReady, false);
  const scope = options(stateRoot);
  const recovered = await verifyDemoDevice(scope, { store, fetcher });
  assert.equal(recovered.stage, 'device_signed_ready');
  assert.equal(signed[0]!.get('x-dharma-message-id'), signed[1]!.get('x-dharma-message-id'));
  assert.equal(signed[1]!.get('x-dharma-sequence'), '1');

  const pendingPath = `${configPath}.pending-status.json`;
  const pending = { url: `${hqUrl}/api/demo/fabric/repositories/${repositoryId}/status?orgId=${orgId}`,
    deviceId, sequence: 2, createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    headers: {} };
  await writeFile(pendingPath, JSON.stringify(pending));
  const recoveredAfterExpiry = await verifyDemoDevice(scope, { store, fetcher });
  assert.equal(recoveredAfterExpiry.stage, 'device_signed_ready');
  assert.equal(signed.at(-1)!.get('x-dharma-sequence'), '2');
  assert.equal((JSON.parse(await readFile(configPath, 'utf8')) as { nextSequence: number }).nextSequence, 3);
});

test('expired status advances once only after a typed sequence conflict', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-expired-'));
  const store = memoryStore();
  const sequences: number[] = [];
  let acceptedSequence = 0;
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/enrollments')) {
      return new Response(JSON.stringify({ ok: true, status: 'pending', organizationId: orgId,
        repositoryId, deviceCode, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
      { status: 202 });
    }
    if (url.pathname.endsWith('/poll')) {
      return new Response(JSON.stringify(approvedEnrollment()),
        { status: 200 });
    }
    const sequence = Number(new Headers(init?.headers).get('x-dharma-sequence'));
    sequences.push(sequence);
    if (sequence !== acceptedSequence + 1) {
      return new Response(JSON.stringify({ ok: false, error: {
        code: 'demo_fabric_sequence_out_of_order', message: 'Device sequence is out of order.',
      } }), { status: 409 });
    }
    acceptedSequence = sequence;
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository }), { status: 200 });
  };
  const connected = await connectDemoDevice(options(stateRoot), { store, fetcher });
  assert.equal(acceptedSequence, 1);
  const configPath = connected.configPath;
  const pendingPath = `${configPath}.pending-status.json`;
  await writeFile(pendingPath, JSON.stringify({
    url: `${hqUrl}/api/demo/fabric/repositories/${repositoryId}/status?orgId=${orgId}`,
    deviceId, sequence: 2, createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), headers: {},
  }));
  acceptedSequence = 2;
  const recovered = await verifyDemoDevice(options(stateRoot), { store, fetcher });
  assert.equal(recovered.stage, 'device_signed_ready');
  assert.deepEqual(sequences, [1, 2, 3]);
  assert.equal((JSON.parse(await readFile(configPath, 'utf8')) as { nextSequence: number }).nextSequence, 4);
});

test('a 0.2.81 pending sequence that skipped an unseen request recovers without another grant', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-legacy-gap-'));
  const store = memoryStore();
  const sequences: number[] = [];
  let lastAccepted = 0;
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/enrollments')) {
      return new Response(JSON.stringify({ ok: true, status: 'pending', organizationId: orgId,
        repositoryId, deviceCode, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
      { status: 202 });
    }
    if (url.pathname.endsWith('/poll')) {
      return new Response(JSON.stringify(approvedEnrollment()),
        { status: 200 });
    }
    const sequence = Number(new Headers(init?.headers).get('x-dharma-sequence'));
    sequences.push(sequence);
    if (sequence !== lastAccepted + 1) {
      return new Response(JSON.stringify({ ok: false, error: {
        code: 'demo_fabric_sequence_out_of_order', message: 'Device sequence is out of order.',
      } }), { status: 409 });
    }
    lastAccepted = sequence;
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository }), { status: 200 });
  };
  const connected = await connectDemoDevice(options(stateRoot), { store, fetcher });
  await writeFile(`${connected.configPath}.pending-status.json`, JSON.stringify({
    url: `${hqUrl}/api/demo/fabric/repositories/${repositoryId}/status?orgId=${orgId}`,
    deviceId, sequence: 3, createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), headers: {},
  }));
  const recovered = await verifyDemoDevice(options(stateRoot), { store, fetcher });
  assert.equal(recovered.stage, 'device_signed_ready');
  assert.deepEqual(sequences, [1, 3, 2]);
  assert.equal((JSON.parse(await readFile(connected.configPath, 'utf8')) as { nextSequence: number }).nextSequence, 3);
});

test('expired status does not advance on an unrelated conflict', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-conflict-'));
  const store = memoryStore();
  const sequences: number[] = [];
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/enrollments')) {
      return new Response(JSON.stringify({ ok: true, status: 'pending', organizationId: orgId,
        repositoryId, deviceCode, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
      { status: 202 });
    }
    if (url.pathname.endsWith('/poll')) {
      return new Response(JSON.stringify(approvedEnrollment()),
        { status: 200 });
    }
    const sequence = Number(new Headers(init?.headers).get('x-dharma-sequence'));
    sequences.push(sequence);
    if (sequence > 1) return new Response(JSON.stringify({ ok: false, error: {
      code: 'demo_fabric_message_replay_conflict', message: 'Message conflict.',
    } }), { status: 409 });
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository }), { status: 200 });
  };
  const connected = await connectDemoDevice(options(stateRoot), { store, fetcher });
  const pendingPath = `${connected.configPath}.pending-status.json`;
  await writeFile(pendingPath, JSON.stringify({
    url: `${hqUrl}/api/demo/fabric/repositories/${repositoryId}/status?orgId=${orgId}`,
    deviceId, sequence: 2, createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), headers: {},
  }));
  await assert.rejects(verifyDemoDevice(options(stateRoot), { store, fetcher }),
    /demo_fabric_message_replay_conflict/);
  assert.deepEqual(sequences, [1, 2]);
  assert.equal((JSON.parse(await readFile(connected.configPath, 'utf8')) as { nextSequence: number }).nextSequence, 2);
});
