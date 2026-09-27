import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalize, sha256, signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { connectDemoDevice, scopePath, verifyDemoDevice } from './demoEnrollment.js';
import { createDemoDeviceTransport } from './demoDeviceTransport.js';
import { acceptDemoTransport } from './demoTransportState.js';

async function fixture(t: TestContext) {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-device-transport-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const scope = { hqUrl: 'https://original.example', organizationId: 'org_fixture',
    repositoryId: '10000000-0000-4000-8000-000000000001', normalizedRepository: 'github.com/example/private',
    installationId: '40000000-0000-4000-8000-000000000001', stateRoot };
  const deviceId = '30000000-0000-4000-8000-000000000001', signer = generateKeyPairSync('ed25519');
  const issuedAt = new Date(Date.now() - 60_000).toISOString(), expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const unsigned = { schema: 'dharma.server-signing-keyset/v1' as const, organizationId: scope.organizationId,
    generation: 1, signedByKeyVersion: 'original', issuedAt, expiresAt,
    keys: [{ keyVersion: 'original', publicKeyEd25519: signer.publicKey.export({ format: 'jwk' }).x!,
      status: 'active' as const, notBefore: issuedAt, notAfter: expiresAt }] };
  const keyset = { ...unsigned, signature: signCanonicalObject(unsigned, signer.privateKey) };
  const values = new Map<string, string>();
  const store: SecureSecretStore = { backend: 'linux-secret-service',
    async get(account) { return values.get(account) ?? null; },
    async getFresh(account) { return values.get(account) ?? null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); } };
  const calls: string[] = [];
  const fetcher: typeof fetch = async resource => {
    const url = new URL(String(resource)); calls.push(url.toString());
    if (url.pathname.endsWith('/enrollments')) return Response.json({ ok: true, status: 'pending',
      organizationId: scope.organizationId, repositoryId: scope.repositoryId, deviceCode: 'B'.repeat(43),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), verificationUri:
        `${scope.hqUrl}/demo/fabric/approve?orgId=${scope.organizationId}&repositoryId=${scope.repositoryId}&code=ABCDEF0123456789ABCD` }, { status: 202 });
    if (url.pathname.endsWith('/poll')) return Response.json({ ok: true, status: 'approved', deviceId,
      repositoryId: scope.repositoryId, serverPublicKeyEd25519: unsigned.keys[0]!.publicKeyEd25519, serverSigningKeyset: keyset });
    return Response.json({ ok: true, organizationId: scope.organizationId, repositoryId: scope.repositoryId,
      deviceId, normalizedRepository: scope.normalizedRepository });
  };
  await connectDemoDevice({ ...scope, grant: 'A'.repeat(43), deviceName: 'Fixture', platform: 'linux', maximumWaitMs: 1000 }, { store, fetcher });
  calls.length = 0;
  const config = JSON.parse(await readFile(scopePath(scope, scope.hqUrl), 'utf8'));
  const binding = { organizationId: scope.organizationId, repositoryId: scope.repositoryId, deviceId,
    installationId: scope.installationId, publicKeyEd25519: config.publicKeyEd25519,
    enrollmentOrigin: scope.hqUrl, protectedKeyset: keyset, minimumPolicyRevision: 1 };
  const target = 'https://corrected.example', now = new Date();
  const body = { schema: 'dharma.demo-transport-continuity/v1', purpose: 'same-authority-repository-transport',
    organizationId: binding.organizationId, repositoryId: binding.repositoryId, deviceId,
    installationId: binding.installationId, publicKeyEd25519: binding.publicKeyEd25519,
    enrollmentOrigin: scope.hqUrl, transportOrigin: target, requestNonce: 'N'.repeat(32), policyRevision: 2,
    trustGeneration: 1, installedKeysetHash: sha256(canonicalize(keyset)), signingKeyVersion: 'original',
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() };
  return { scope, store, fetcher, calls, values, config, binding, target,
    issue: async (resource: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(String(resource));
      const request = JSON.parse(String(init?.body)), now = new Date();
      const issued = { ...body, ...request, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() };
      const correlationId = new Headers(init?.headers).get('x-dharma-correlation-id')!;
      return Response.json({ ok: true, certificate: { ...issued, signature: signCanonicalObject(issued, signer.privateKey) },
        duplicate: false, correlationId }, { headers: { 'x-dharma-correlation-id': correlationId } });
    },
    shortCertificate: () => {
      const issued = { ...body, expiresAt: new Date(Date.now() + 30_000).toISOString() };
      return { ...issued, signature: signCanonicalObject(issued, signer.privateKey) };
    },
    certificate: { ...body, signature: signCanonicalObject(body, signer.privateKey) } };
}

test('enrolled status resolves the new transport under original config/key accounts and keeps its sequence', async t => {
  const f = await fixture(t), enrollmentRecords = new Map(f.values);
  await acceptDemoTransport(f.certificate, f.binding,
    { transportOrigin: f.target, requestNonce: f.certificate.requestNonce }, { store: f.store });
  const deps = await createDemoDeviceTransport(f.scope, { store: f.store, fetcher: f.fetcher });
  await verifyDemoDevice(f.scope, deps);
  assert.equal(f.calls.length, 1);
  assert.equal(new URL(f.calls[0]!).origin, f.target);
  const config = JSON.parse(await readFile(scopePath(f.scope, f.scope.hqUrl), 'utf8'));
  for (const field of ['hqUrl', 'deviceId', 'installationId', 'publicKeyEd25519', 'enrolledAt']) assert.equal(config[field], f.config[field]);
  assert.equal(config.nextSequence, f.config.nextSequence + 1);
  for (const [account, value] of enrollmentRecords) assert.equal(f.values.get(account), value);
});

test('ordinary unmapped status keeps its original origin and signing behavior', async t => {
  const f = await fixture(t), before = [...f.values];
  await verifyDemoDevice(f.scope, await createDemoDeviceTransport(f.scope, { store: f.store, fetcher: f.fetcher }));
  assert.equal(new URL(f.calls[0]!).origin, f.scope.hqUrl);
  assert.deepEqual([...f.values], before);
});

test('a missing or corrupted enrolled identity never generates a replacement', async t => {
  const f = await fixture(t);
  const identityAccount = [...f.values].find(([, value]) => value.includes('"d":'))![0];
  for (const value of [null, 'corrupted']) {
    if (value === null) f.values.delete(identityAccount); else f.values.set(identityAccount, value);
    const before = [...f.values];
    await assert.rejects(createDemoDeviceTransport(f.scope, { store: f.store, fetcher: f.fetcher }));
    assert.deepEqual([...f.values], before);
  }
  assert.equal(f.calls.length, 0);
});

test('operation dependencies prohibit replacement of the original identity while retaining trust-update capability', async t => {
  const f = await fixture(t), before = [...f.values];
  const identityAccount = [...f.values].find(([, value]) => value.includes('"d":'))![0];
  const deps = await createDemoDeviceTransport(f.scope, { store: f.store, fetcher: f.fetcher });
  await assert.rejects(deps.store.put(identityAccount, 'replacement'), /existing_protected_state_required/);
  await assert.rejects(deps.store.delete(identityAccount), /existing_protected_state_required/);
  assert.deepEqual([...f.values], before);
});

test('lost status responses resume the same original pending request after transport setup restarts', async t => {
  const f = await fixture(t), before = new Map(f.values), sequences: string[] = [];
  await acceptDemoTransport(f.certificate, f.binding,
    { transportOrigin: f.target, requestNonce: f.certificate.requestNonce }, { store: f.store });
  let lost = false;
  const network: typeof fetch = async (resource, init) => {
    assert.equal(new URL(String(resource)).origin, f.target);
    sequences.push(new Headers(init?.headers).get('x-dharma-sequence')!);
    const response = await f.fetcher(resource, init);
    if (!lost) { lost = true; throw new TypeError('Fixture response lost after acceptance'); }
    return response;
  };
  await assert.rejects(verifyDemoDevice(f.scope,
    await createDemoDeviceTransport(f.scope, { store: f.store, fetcher: network })), /response lost/);
  const pendingPath = `${scopePath(f.scope, f.scope.hqUrl)}.pending-status.json`;
  const pending = JSON.parse(await readFile(pendingPath, 'utf8'));
  assert.equal(new URL(pending.url).origin, f.scope.hqUrl);
  await verifyDemoDevice(f.scope, await createDemoDeviceTransport(f.scope, { store: f.store, fetcher: network }));
  assert.deepEqual(sequences, [String(f.config.nextSequence), String(f.config.nextSequence)]);
  const after = JSON.parse(await readFile(scopePath(f.scope, f.scope.hqUrl), 'utf8'));
  assert.equal(after.nextSequence, f.config.nextSequence + 1);
  for (const [account, value] of before) assert.equal(f.values.get(account), value);
  await assert.rejects(readFile(pendingPath), { code: 'ENOENT' });
});
test('grant-free issuance cannot consume the business sequence, and pending status resumes unchanged', async t => {
  const f = await fixture(t), before = new Map(f.values), sequences: string[] = [];
  let lost = true;
  const network: typeof fetch = async (resource, init) => {
    if (String(resource).includes('/transport-continuity')) return f.issue(resource, init);
    sequences.push(new Headers(init?.headers).get('x-dharma-sequence')!);
    if (lost) { lost = false; throw new TypeError('Fixture status response lost'); }
    return f.fetcher(resource, init);
  };
  await assert.rejects(verifyDemoDevice(f.scope, await createDemoDeviceTransport(f.scope, { store: f.store, fetcher: network })), /response lost/);
  const pendingPath = `${scopePath(f.scope, f.scope.hqUrl)}.pending-status.json`;
  const pendingBefore = await readFile(pendingPath, 'utf8');
  const deps = await createDemoDeviceTransport(f.scope, { store: f.store, fetcher: network });
  await deps.connectTransport(f.target);
  assert.equal(await readFile(pendingPath, 'utf8'), pendingBefore);
  assert.equal(JSON.parse(await readFile(scopePath(f.scope, f.scope.hqUrl), 'utf8')).nextSequence, f.config.nextSequence);
  await verifyDemoDevice(f.scope, deps);
  assert.deepEqual(sequences, [String(f.config.nextSequence), String(f.config.nextSequence)]);
  assert.equal(JSON.parse(await readFile(scopePath(f.scope, f.scope.hqUrl), 'utf8')).nextSequence, f.config.nextSequence + 1);
  for (const [account, value] of before) assert.equal(f.values.get(account), value);
});
test('routine status refreshes near-expiry transport autonomously before unchanged signed work', async t => {
  const f = await fixture(t), before = new Map(f.values);
  await acceptDemoTransport(f.shortCertificate(), f.binding,
    { transportOrigin: f.target, requestNonce: f.certificate.requestNonce }, { store: f.store });
  const network: typeof fetch = (resource, init) => String(resource).includes('/transport-continuity') ? f.issue(resource, init) : f.fetcher(resource, init);
  await verifyDemoDevice(f.scope, await createDemoDeviceTransport(f.scope, { store: f.store, fetcher: network }));
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0]!.includes('/transport-continuity')); assert.ok(f.calls[1]!.includes('/status'));
  assert.equal(JSON.parse(await readFile(scopePath(f.scope, f.scope.hqUrl), 'utf8')).nextSequence, f.config.nextSequence + 1);
  for (const [account, value] of before) assert.equal(f.values.get(account), value);
});
