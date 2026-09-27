import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256, signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { createSystemSecureStore } from '@dharma-ai-labs/agent-fabric-secure-store';
import { acceptDemoTransport, resolveDemoTransport } from '../packages/cli/dist/demoTransportState.js';

const store = await createSystemSecureStore();
if (process.argv[2] === '--read-fixture') {
  const binding = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const result = await resolveDemoTransport(binding, { store });
  assert.equal(result.state, 'ready');
  assert.equal(result.transportOrigin, 'https://corrected.example');
  process.stdout.write(`${JSON.stringify({ backend: store.backend, restored: true, generation: result.certificate.trustGeneration })}\n`);
} else {
  const signer = generateKeyPairSync('ed25519'), now = new Date();
  const organizationId = `org_smoke${randomUUID().replaceAll('-', '')}`;
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  const body = { schema: 'dharma.server-signing-keyset/v1', organizationId, generation: 1,
    signedByKeyVersion: 'fixture', issuedAt: new Date(now.getTime() - 1_000).toISOString(), expiresAt,
    keys: [{ keyVersion: 'fixture', publicKeyEd25519: signer.publicKey.export({ format: 'jwk' }).x,
      status: 'active', notBefore: new Date(now.getTime() - 60_000).toISOString(), notAfter: expiresAt }] };
  const keyset = { ...body, signature: signCanonicalObject(body, signer.privateKey) };
  const identity = { organizationId, repositoryId: randomUUID(), deviceId: randomUUID(), installationId: randomUUID(),
    publicKeyEd25519: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x,
    enrollmentOrigin: 'https://original.example' };
  const binding = { ...identity, protectedKeyset: keyset, minimumPolicyRevision: 1 };
  const account = `demo-transport-${sha256(canonicalize(identity)).slice(7)}`;
  const accounts = [account, `${account}-journal`];
  for (const name of accounts) assert.equal(await store.getFresh(name), null, 'fixture account must be vacant');
  const directory = await mkdtemp(resolve(tmpdir(), 'dharma-transport-smoke-'));
  const path = resolve(directory, 'public-binding.json');
  const written = new Set();
  const scopedStore = { backend: store.backend,
    get: name => { assert.ok(accounts.includes(name)); return store.getFresh(name); },
    getFresh: name => { assert.ok(accounts.includes(name)); return store.getFresh(name); },
    async put(name, value) { assert.ok(accounts.includes(name)); written.add(name); await store.put(name, value); },
    async delete(name) { assert.ok(accounts.includes(name)); await store.delete(name); } };
  let restarted = false, cleaned = false;
  try {
    const unsigned = { schema: 'dharma.demo-transport-continuity/v1', purpose: 'same-authority-repository-transport',
      ...identity, transportOrigin: 'https://corrected.example', requestNonce: 'N'.repeat(32), policyRevision: 1,
      trustGeneration: 1, installedKeysetHash: sha256(canonicalize(keyset)), signingKeyVersion: 'fixture',
      issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() };
    await acceptDemoTransport({ ...unsigned, signature: signCanonicalObject(unsigned, signer.privateKey) }, binding,
      { transportOrigin: unsigned.transportOrigin, requestNonce: unsigned.requestNonce }, { store: scopedStore });
    await writeFile(path, JSON.stringify(binding), { flag: 'wx', mode: 0o600 });
    const child = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--read-fixture', path],
      { windowsHide: true, timeout: 120_000, maxBuffer: 8192 });
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.backend, store.backend);
    assert.equal(result.restored, true);
    restarted = true;
  } finally {
    for (const name of written) await store.delete(name);
    cleaned = true;
    for (const name of accounts) if (await store.getFresh(name) !== null) cleaned = false;
    await rm(directory, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({ backend: store.backend, restarted, cleaned,
      fixtureOnly: true, enrollmentCredentialsTouched: false, networkCalls: 0 })}\n`);
  }
  assert.equal(restarted && cleaned, true);
}
