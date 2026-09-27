import { createHash, createPrivateKey } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { canonicalize, signCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { loadOrCreateDeviceIdentity, normalizeHqUrl, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { createSystemSecureStore } from '@dharma-ai-labs/agent-fabric-secure-store';
import { loadDemoSigningTrust, scopePath, type DemoDeviceScope } from './demoEnrollment.js';

type Consumer = { name: string; version: string };
interface UpgradeContext {
  schema: 'dharma.signing-upgrade-context/v1'; organizationId: string; repositoryId: string;
  globalEpoch: string; predecessorHash: string; candidateHash: string; installedKeysetHash: string;
  baselineConsumers: Consumer[]; requiredConsumers: Consumer[]; requiredClientIds: string[]; expiresAt: string;
}
type Common = Pick<UpgradeContext, 'organizationId' | 'globalEpoch' | 'predecessorHash' | 'candidateHash' | 'expiresAt'> & {
  principalId: string; observedAt: string; signature: string; sourceHash: string;
};
type Source = Common & (
  { schema: 'dharma.signing-client-upgrade-proof/v1'; cliVersion: string; contractVersion: string; installedKeysetHash: string }
  | { schema: 'dharma.signing-consumer-approval/v1'; baselineConsumers: Consumer[]; requiredConsumers: Consumer[]; requiredClientIds: string[] });
let validators: Promise<{ context: ValidateFunction<UpgradeContext>; source: ValidateFunction<Source> }> | undefined;
function runtimeValidators() {
  return validators ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const addFormats = createRequire(import.meta.url)('ajv-formats').default as FormatsPlugin;
    addFormats(ajv);
    for (const name of ['signing-upgrade-context', 'signing-upgrade-source']) {
      ajv.addSchema(JSON.parse(await readFile(new URL(`./schemas/${name}.schema.json`, import.meta.url), 'utf8')));
    }
    return { context: ajv.getSchema<UpgradeContext>('https://schemas.dharma-ai.io/signing-upgrade-context/v1')!,
      source: ajv.getSchema<Source>('https://schemas.dharma-ai.io/signing-upgrade-source/v1')! };
  })();
}
function fail(reason: string): never { throw new Error(`Signing upgrade proof rejected: ${reason}.`); }
async function installedVersion(url: URL, name: string) {
  const value: unknown = JSON.parse(await readFile(url, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('package_metadata_invalid');
  const record = value as Record<string, unknown>;
  if (record.name !== name || typeof record.version !== 'string'
    || !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(record.version)) fail('package_metadata_invalid');
  return record.version;
}
function bytewiseHash(value: unknown) {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort()
      .map(key => [key, ordered((item as Record<string, unknown>)[key])])) : item;
  return `sha256:${createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')}`;
}
function before(next: string, previous: string) {
  const n = next.split('.').map(Number), p = previous.split('.').map(Number);
  const index = n.findIndex((part, i) => part !== p[i]);
  return index >= 0 && n[index]! < p[index]!;
}

export async function readDemoSigningUpgradeContext(path: string): Promise<unknown> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(32769);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (!count || count > 32768) fail('context_size_invalid');
    try { return JSON.parse(buffer.subarray(0, count).toString('utf8')); }
    catch { fail('context_json_invalid'); }
  } finally { await handle.close(); }
}

// Context is an operator review request, not authority. The server independently
// validates its preload/inventory; owner consent still requires the browser.
export async function prepareDemoSigningUpgradeProof(input: DemoDeviceScope, value: unknown,
  kind: 'client' | 'owner', deps: { store?: SecureSecretStore; now?: Date } = {}) {
  const scope = structuredClone(input), context: unknown = structuredClone(value);
  const now = new Date((deps.now ?? new Date()).getTime()), validate = await runtimeValidators();
  if (!validate.context(context) || !['client', 'owner'].includes(kind)
    || !Number.isFinite(now.getTime())) fail('context_invalid');
  const expires = Date.parse(context.expiresAt);
  if (context.organizationId !== scope.organizationId || context.repositoryId !== scope.repositoryId
    || context.predecessorHash === context.candidateHash || expires <= now.getTime()
    || expires > now.getTime() + 15 * 60_000) fail('scope_or_expiry_invalid');
  const baseline = context.baselineConsumers, required = context.requiredConsumers;
  if (new Set(baseline.map(c => c.name)).size !== baseline.length
    || new Set(required.map(c => c.name)).size !== required.length || required.length !== baseline.length
    || baseline.some(c => { const next = required.find(n => n.name === c.name); return !next || before(next.version, c.version); })
    || !required.some(c => c.name === 'cli') || !required.some(c => c.name === 'contracts')) fail('consumer_inventory_invalid');
  const cliVersion = await installedVersion(new URL('../package.json', import.meta.url), '@dharma-ai-labs/agent-fabric');
  const contractVersion = await installedVersion(new URL('../package.json', import.meta.resolve('@dharma-ai-labs/agent-fabric-contracts')),
    '@dharma-ai-labs/agent-fabric-contracts');
  if (required.find(c => c.name === 'cli')!.version !== cliVersion
    || required.find(c => c.name === 'contracts')!.version !== contractVersion) fail('required_versions_not_installed');
  const store = deps.store ?? await createSystemSecureStore();
  const fresh = (account: string) => store.getFresh ? store.getFresh(account) : store.get(account);
  const readOnlyStore: SecureSecretStore = { backend: store.backend, get: fresh, getFresh: fresh,
    async put() { fail('existing_protected_state_required'); },
    async delete() { fail('existing_protected_state_required'); } };
  const trust = await loadDemoSigningTrust(scope, { store: readOnlyStore, now });
  const keysetHash = `sha256:${createHash('sha256').update(canonicalize(trust.keyset)).digest('hex')}`;
  if (keysetHash !== context.installedKeysetHash || trust.keyset.generation < 2
    || !trust.keyset.keys.some(k => k.status === 'overlap')
    || expires > Date.parse(trust.keyset.expiresAt) || Date.parse(trust.keyset.issuedAt) > now.getTime()
    || (kind === 'client' && !context.requiredClientIds.includes(trust.deviceId))) fail('original_preloaded_client_required');
  const identity = await loadOrCreateDeviceIdentity({ hqUrl: normalizeHqUrl(scope.hqUrl),
    organizationId: `${scope.organizationId}:${scope.repositoryId}`, installationId: scope.installationId, store: readOnlyStore });
  const saved: unknown = JSON.parse(await readFile(scopePath(scope, normalizeHqUrl(scope.hqUrl)), 'utf8'));
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) fail('device_state_changed');
  const config = saved as Record<string, unknown>;
  if (config.deviceId !== trust.deviceId || config.publicKeyEd25519 !== identity.publicKeyEd25519
    || config.organizationId !== scope.organizationId || config.repositoryId !== scope.repositoryId
    || config.installationId !== scope.installationId || config.normalizedRepository !== scope.normalizedRepository
    || typeof config.enrolledAt !== 'string' || !Number.isFinite(Date.parse(config.enrolledAt))
    || Date.parse(config.enrolledAt) > now.getTime()) fail('device_state_changed');
  const finalTrust = await loadDemoSigningTrust(scope, { store: readOnlyStore, now });
  if (finalTrust.deviceId !== trust.deviceId || canonicalize(finalTrust.keyset) !== canonicalize(trust.keyset)) fail('device_state_changed');
  const signingTime = new Date((deps.now ?? new Date()).getTime());
  if (!Number.isFinite(signingTime.getTime()) || signingTime.getTime() >= expires
    || signingTime.getTime() - now.getTime() > 15 * 60_000) fail('context_expired_during_preparation');
  const unsigned = { schema: kind === 'client' ? 'dharma.signing-client-upgrade-proof/v1' : 'dharma.signing-consumer-approval/v1',
    organizationId: scope.organizationId, globalEpoch: context.globalEpoch, predecessorHash: context.predecessorHash,
    candidateHash: context.candidateHash, principalId: kind === 'client' ? trust.deviceId : `owner:${trust.deviceId}`,
    observedAt: now.toISOString(), expiresAt: context.expiresAt,
    ...(kind === 'client' ? { cliVersion, contractVersion, installedKeysetHash: keysetHash }
      : { baselineConsumers: baseline, requiredConsumers: required, requiredClientIds: context.requiredClientIds }) };
  const signed = { ...unsigned, signature: signCanonicalObject(unsigned,
    createPrivateKey({ key: identity.privateJwk, format: 'jwk' })) };
  const proof = { ...signed, sourceHash: bytewiseHash(signed) };
  if (!validate.source(proof)) fail('source_schema_invalid');
  return { ok: true, stage: 'proof_prepared' as const, organizationId: scope.organizationId,
    repositoryId: scope.repositoryId, deviceId: trust.deviceId, submitted: false as const,
    browserApprovalRequired: kind === 'owner', proof };
}
