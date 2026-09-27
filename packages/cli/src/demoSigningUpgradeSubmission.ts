import { createHash, createPublicKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalize, verifyCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { loadOrCreateDeviceIdentity, normalizeHqUrl, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { createSystemSecureStore } from '@dharma-ai-labs/agent-fabric-secure-store';
import { loadDemoSigningTrust, scopePath, verifyDemoDevice, type DemoDeviceScope } from './demoEnrollment.js';
import { prepareDemoSigningUpgradeProof, readDemoSigningUpgradeContext } from './demoSigningUpgradeProof.js';

type Proof = Awaited<ReturnType<typeof prepareDemoSigningUpgradeProof>>['proof'];
type Dependencies = { store?: SecureSecretStore; fetcher?: typeof fetch };
function fail(reason: string): never { throw new Error(`Signing proof submission rejected: ${reason}. Preserve pending proof for recovery.`); }
function rejectedReceipt(code: string, correlationId: string, status: number): never {
  throw Object.assign(new Error(`Signing proof submission failed at client_proof_submission: ${code} (HTTP ${status}). Request correlation: ${correlationId}. Preserve pending proof for recovery.`),
    { stage: 'client_proof_submission', code, correlationId, status });
}

function validatePending(value: unknown, expected: Proof, publicKey: string): Proof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('pending_proof_invalid');
  const proof = value as Proof;
  const { sourceHash, signature, observedAt, ...fields } = proof;
  const { sourceHash: _hash, signature: _signature, observedAt: _observed, ...expectedFields } = expected;
  const observed = Date.parse(observedAt), now = Date.now();
  if (canonicalize(fields) !== canonicalize(expectedFields) || !Number.isFinite(observed)
    || observed > now || observed < now - 15 * 60_000 || Date.parse(proof.expiresAt) <= now
    || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) fail('pending_proof_invalid');
  const { sourceHash: _source, ...signed } = proof;
  if (sourceHash !== `sha256:${createHash('sha256').update(canonicalize(signed)).digest('hex')}`) fail('pending_proof_invalid');
  const { signature: _sig, ...unsigned } = signed;
  try {
    if (!verifyCanonicalObject(unsigned, signature, createPublicKey({ key: {
      kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }))) fail('pending_proof_invalid');
  } catch { fail('pending_proof_invalid'); }
  return proof;
}

async function privateWrite(path: string, proof: Proof) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(proof)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

async function readReceipt(response: Response) {
  if (response.redirected || response.status >= 300 && response.status < 400
    || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')
    || !response.body || Number(response.headers.get('content-length') || 0) > 8192) fail('receipt_invalid');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8192) {
        void reader.cancel().catch(() => undefined); fail('receipt_size_invalid');
      }
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('receipt_invalid');
    return value as Record<string, unknown>;
  } catch { fail('receipt_invalid'); }
  finally { reader.releaseLock(); }
}

// Invoke under the existing device operation lock. The journal retains the same
// signed source after a lost response; status reconciles transport sequences.
export async function submitDemoSigningUpgradeProof(input: DemoDeviceScope, value: unknown, deps: Dependencies = {}) {
  const scope = structuredClone(input), context: unknown = structuredClone(value);
  const store = deps.store ?? await createSystemSecureStore();
  const fresh = (account: string) => store.getFresh ? store.getFresh(account) : store.get(account);
  const readOnlyStore: SecureSecretStore = { backend: store.backend, get: fresh, getFresh: fresh,
    async put() { fail('existing_protected_state_required'); }, async delete() { fail('existing_protected_state_required'); } };
  const prepared = await prepareDemoSigningUpgradeProof(scope, context, 'client', { store: readOnlyStore });
  const origin = normalizeHqUrl(scope.hqUrl), configPath = scopePath(scope, origin);
  const pendingPath = `${configPath}.pending-signing-upgrade.json`;
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  let proof = prepared.proof, resumed = false;
  try {
    proof = validatePending(await readDemoSigningUpgradeContext(pendingPath), proof, config.publicKeyEd25519);
    resumed = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const sourceUrl = new URL(`/api/demo/fabric/repositories/${scope.repositoryId}/signing-upgrade-sources`, origin);
  sourceUrl.searchParams.set('orgId', scope.organizationId);
  const statusUrl = new URL(`/api/demo/fabric/repositories/${scope.repositoryId}/status`, origin);
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.origin !== origin || url.username || url.password || url.hash
      || ![sourceUrl.pathname, statusUrl.pathname].includes(url.pathname)
      || url.searchParams.get('orgId') !== scope.organizationId) fail('transport_scope_invalid');
    const options = { ...init, redirect: 'error' as const, cache: 'no-store', signal: AbortSignal.timeout(15_000) };
    const response = await (deps.fetcher || fetch)(resource, options);
    if (response.redirected || response.status >= 300 && response.status < 400
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) fail('receipt_invalid');
    const body = await readReceipt(response), headers = new Headers(response.headers);
    headers.delete('content-length');
    if (!response.ok) {
      const error = body.error && typeof body.error === 'object' && !Array.isArray(body.error)
        ? body.error as Record<string, unknown> : {};
      const code = typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,119}$/.test(error.code)
        ? error.code : `http_${response.status}`;
      const correlation = headers.get('x-dharma-correlation-id');
      const suffix = correlation && /^[0-9a-f-]{36}$/i.test(correlation) ? ` Correlation: ${correlation}.` : '';
      return Response.json({ ok: false, error: { code, message: `Signed device request rejected.${suffix}`,
        correlationId: suffix ? correlation : null } },
        { status: response.status, headers });
    }
    return Response.json(body, { status: response.status, headers });
  };
  await verifyDemoDevice(scope, { store: readOnlyStore, fetcher, expectedAcceptedSequence: config.nextSequence });
  const latest = await prepareDemoSigningUpgradeProof(scope, context, 'client', { store: readOnlyStore });
  const current = JSON.parse(await readFile(configPath, 'utf8'));
  proof = validatePending(proof, latest.proof, current.publicKeyEd25519);
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: origin,
    organizationId: `${scope.organizationId}:${scope.repositoryId}`, installationId: scope.installationId, store: readOnlyStore });
  if (identity.publicKeyEd25519 !== current.publicKeyEd25519 || current.deviceId !== prepared.deviceId
    || !Number.isSafeInteger(current.nextSequence) || current.nextSequence < 1) fail('device_state_changed');
  const finalTrust = await loadDemoSigningTrust(scope, { store: readOnlyStore });
  if (finalTrust.deviceId !== prepared.deviceId
    || proof.schema !== 'dharma.signing-client-upgrade-proof/v1'
    || proof.installedKeysetHash !== `sha256:${createHash('sha256').update(canonicalize(finalTrust.keyset)).digest('hex')}`) fail('device_state_changed');
  const rawBody = JSON.stringify({ proof });
  if (Buffer.byteLength(rawBody) > 8192 || Date.parse(proof.expiresAt) <= Date.now()) fail('proof_expired_or_oversized');
  const sequence = current.nextSequence, sessionId = randomUUID(), messageId = randomUUID();
  const timestamp = new Date().toISOString(), nonce = randomBytes(24).toString('base64url'), correlationId = randomUUID();
  const payload = { bodyHash: `sha256:${createHash('sha256').update(rawBody).digest('hex')}`,
    deviceId: prepared.deviceId, messageId, method: 'POST', nonce, organizationId: scope.organizationId,
    pathname: `${sourceUrl.pathname}${sourceUrl.search}`, sequence, sessionId, timestamp };
  await privateWrite(pendingPath, proof);
  if (Date.parse(proof.expiresAt) <= Date.now()) fail('proof_expired_during_submission');
  const response = await fetcher(sourceUrl.toString(), { method: 'POST', body: rawBody, headers: {
    'content-type': 'application/json', 'x-dharma-device-id': prepared.deviceId,
    'x-dharma-session-id': sessionId, 'x-dharma-message-id': messageId, 'x-dharma-timestamp': timestamp,
    'x-dharma-nonce': nonce, 'x-dharma-sequence': String(sequence), 'x-dharma-correlation-id': correlationId,
    'x-dharma-signature': sign(null, Buffer.from(JSON.stringify(payload)), { key: identity.privateJwk, format: 'jwk' }).toString('base64url'),
  } });
  const receipt = await readReceipt(response);
  if (response.status !== 200) {
    const error = receipt.error && typeof receipt.error === 'object' && !Array.isArray(receipt.error)
      ? receipt.error as Record<string, unknown> : {};
    const matched = response.headers.get('x-dharma-correlation-id') === correlationId
      && error.correlationId === correlationId && typeof error.code === 'string'
      && /^[a-z][a-z0-9_]{0,119}$/.test(error.code);
    rejectedReceipt(matched ? error.code as string : 'receipt_invalid', correlationId, response.status);
  }
  if (receipt.ok !== true || receipt.organizationId !== scope.organizationId
    || receipt.repositoryId !== scope.repositoryId || receipt.deviceId !== prepared.deviceId
    || receipt.sourceHash !== proof.sourceHash || typeof receipt.duplicate !== 'boolean'
    || receipt.correlationId !== correlationId || response.headers.get('x-dharma-correlation-id') !== correlationId) rejectedReceipt('receipt_invalid', correlationId, response.status);
  await verifyDemoDevice(scope, { store: readOnlyStore, fetcher, expectedAcceptedSequence: sequence });
  await unlink(pendingPath);
  return { ok: true, stage: 'client_proof_recorded' as const, submitted: true, activated: false,
    organizationId: scope.organizationId, repositoryId: scope.repositoryId, deviceId: prepared.deviceId,
    sourceHash: proof.sourceHash, correlationId, duplicate: receipt.duplicate, resumed };
}
