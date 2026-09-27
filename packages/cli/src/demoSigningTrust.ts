import { createHash, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { canonicalize, verifyInitialServerSigningKeyset, verifyServerSigningKeysetUpdate,
  validateTrustedServerSigningKeysetContract, type TrustedServerSigningKeyset } from '@dharma-ai-labs/agent-fabric-contracts';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { createSystemSecureStore } from '@dharma-ai-labs/agent-fabric-secure-store';

export interface DemoSigningConfig {
  schema: 'dharma.demo-device/v1'; hqUrl: string; organizationId: string;
  repositoryId: string; normalizedRepository: string; installationId: string;
  deviceId: string; publicKeyEd25519: string; enrolledAt: string;
  serverPublicKeyEd25519?: string; serverSigningKeyset?: TrustedServerSigningKeyset;
}
export interface DemoSigningDependencies { store?: SecureSecretStore; now?: Date }
interface DemoSigningUpdate {
  schema: 'dharma.demo-signing-update/v1'; organizationId: string; repositoryId: string;
  deviceId: string; issuedAt: string; expiresAt: string; keysets: TrustedServerSigningKeyset[];
}
let updateValidator: Promise<ValidateFunction<DemoSigningUpdate>> | undefined;
function signingUpdateValidator() {
  return updateValidator ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const addFormats = createRequire(import.meta.url)('ajv-formats').default as FormatsPlugin;
    addFormats(ajv);
    for (const file of ['server-signing-keyset', 'demo-signing-update']) {
      ajv.addSchema(JSON.parse(await readFile(new URL(`./schemas/${file}.schema.json`, import.meta.url), 'utf8')));
    }
    return ajv.getSchema<DemoSigningUpdate>('https://schemas.dharma-ai.io/demo-signing-update/v1')!;
  })();
}

function failure(reason: string): never {
  throw new Error(`Demo signing trust rejected: ${reason}. Use browser-authorized re-enrollment if trust has expired.`);
}
function binding(config: DemoSigningConfig) {
  return { schema: 'dharma.demo-signing-anchor/v1' as const, hqUrl: config.hqUrl,
    organizationId: config.organizationId, repositoryId: config.repositoryId,
    normalizedRepository: config.normalizedRepository, installationId: config.installationId,
    deviceId: config.deviceId, publicKeyEd25519: config.publicKeyEd25519,
    enrolledAt: config.enrolledAt, serverPublicKeyEd25519: config.serverPublicKeyEd25519 };
}
function accountFor(config: DemoSigningConfig) {
  return `demo-signing-${createHash('sha256').update(canonicalize({ hqUrl: config.hqUrl,
    organizationId: config.organizationId, repositoryId: config.repositoryId,
    installationId: config.installationId, deviceId: config.deviceId })).digest('hex').slice(0, 32)}`;
}
function checkKeyset(keyset: TrustedServerSigningKeyset, org: string, now: Date, pin?: string) {
  if (!validateTrustedServerSigningKeysetContract(keyset).ok) failure('schema_invalid');
  const signer = keyset.keys.find(k => k.keyVersion === keyset.signedByKeyVersion);
  if (!signer || signer.status !== 'active' || keyset.keys.filter(k => k.status === 'active').length !== 1
    || new Set(keyset.keys.map(k => k.keyVersion)).size !== keyset.keys.length
    || Date.parse(signer.notBefore) > now.getTime() || Date.parse(signer.notAfter) < Date.parse(keyset.expiresAt)) {
    failure('signing_roles_or_lifetime_invalid');
  }
  // A self-signature is sufficient only after authority has come from the OS
  // anchor or a verified predecessor. It never establishes a new enrollment pin.
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pin ?? signer.publicKeyEd25519 }, format: 'jwk' });
  const verification = verifyInitialServerSigningKeyset(keyset, key, org, now);
  if (!verification.ok) failure(verification.reason ?? 'invalid_keyset');
}
async function saveAnchor(config: DemoSigningConfig, store: SecureSecretStore) {
  const serialized = canonicalize({ ...binding(config), serverSigningKeyset: config.serverSigningKeyset });
  const account = accountFor(config);
  await store.put(account, serialized);
  if (await store.get(account) !== serialized) failure('secure_store_write_not_confirmed');
}

export async function resolveDemoSigningTrust<T extends DemoSigningConfig>(config: T,
  deps: DemoSigningDependencies = {}): Promise<T> {
  const now = deps.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || !/^[A-Za-z0-9_-]{43}$/.test(config.serverPublicKeyEd25519 ?? '')
    || !config.serverSigningKeyset) failure('missing_enrollment_trust');
  const store = deps.store ?? await createSystemSecureStore();
  const serialized = await store.get(accountFor(config));
  if (!serialized) {
    // Compatibility migration is allowed only while the originally pinned
    // bootstrap is valid. An expired or already-rotated disk file cannot bootstrap.
    checkKeyset(config.serverSigningKeyset, config.organizationId, now, config.serverPublicKeyEd25519);
    await saveAnchor(config, store);
    return config;
  }
  let anchor: ReturnType<typeof binding> & { serverSigningKeyset?: TrustedServerSigningKeyset };
  try { anchor = JSON.parse(serialized); }
  catch { failure('protected_anchor_malformed'); }
  const { serverSigningKeyset, ...base } = anchor;
  if (canonicalize(base) !== canonicalize(binding(config)) || !serverSigningKeyset) failure('protected_anchor_binding_mismatch');
  checkKeyset(serverSigningKeyset, config.organizationId, now);
  if (!validateTrustedServerSigningKeysetContract(config.serverSigningKeyset).ok
    || config.serverSigningKeyset.generation > serverSigningKeyset.generation
    || (config.serverSigningKeyset.generation === serverSigningKeyset.generation
      && canonicalize(config.serverSigningKeyset) !== canonicalize(serverSigningKeyset))) failure('protected_anchor_conflict');
  return { ...config, serverSigningKeyset };
}

// Callers hold the existing per-device operation lock. The protected anchor is
// the write-ahead record; a restart repairs an older disk config from this record.
export async function acceptDemoSigningKeysets<T extends DemoSigningConfig>(config: T,
  chain: TrustedServerSigningKeyset[], deps: DemoSigningDependencies = {}): Promise<T> {
  if (!Array.isArray(chain) || chain.length > 20) failure('chain_limit');
  const now = deps.now ?? new Date();
  const store = deps.store ?? await createSystemSecureStore();
  let updated = await resolveDemoSigningTrust(config, { ...deps, store, now });
  for (const candidate of chain) {
    const current = updated.serverSigningKeyset!;
    if (canonicalize(current) === canonicalize(candidate)) continue;
    if (!validateTrustedServerSigningKeysetContract(candidate).ok
      || candidate.generation !== current.generation + 1) failure('generation_conflict');
    const verification = verifyServerSigningKeysetUpdate(current, candidate, now);
    if (!verification.ok) failure(verification.reason ?? 'transition_invalid');
    checkKeyset(candidate, config.organizationId, now);
    if (Date.parse(candidate.expiresAt) <= now.getTime() + 600_000
      || Date.parse(candidate.expiresAt) - Date.parse(candidate.issuedAt) > 29 * 86_400_000) failure('transition_lifetime_invalid');
    for (const old of current.keys) {
      const retained = candidate.keys.find(k => k.keyVersion === old.keyVersion);
      if (!retained || retained.publicKeyEd25519 !== old.publicKeyEd25519
        || retained.notBefore !== old.notBefore || retained.notAfter !== old.notAfter) failure('retained_window_changed');
    }
    const active = candidate.keys.find(k => k.status === 'active')!;
    const previousActive = current.keys.find(k => k.status === 'active')!;
    const introduced = candidate.keys.filter(k => !current.keys.some(old => old.keyVersion === k.keyVersion));
    if (active.keyVersion === previousActive.keyVersion) {
      if (introduced.length !== 1 || introduced[0]!.status !== 'overlap'
        || Date.parse(introduced[0]!.notBefore) > now.getTime()
        || Date.parse(introduced[0]!.notAfter) <= now.getTime() + 600_000
        || candidate.keys.length !== current.keys.length + 1
        || current.keys.some(old => candidate.keys.find(k => k.keyVersion === old.keyVersion)!.status !== old.status)) {
        failure('preload_invalid');
      }
    } else {
      if (introduced.length !== 0 || current.keys.find(k => k.keyVersion === active.keyVersion)?.status !== 'overlap'
        || candidate.keys.length !== current.keys.length
        || current.keys.some(old => candidate.keys.find(k => k.keyVersion === old.keyVersion)!.status
          !== (old.keyVersion === active.keyVersion ? 'active' : old.keyVersion === previousActive.keyVersion ? 'overlap' : old.status))) {
        failure('activation_without_preload');
      }
    }
    updated = { ...updated, serverSigningKeyset: structuredClone(candidate) };
  }
  if (canonicalize(updated.serverSigningKeyset) !== canonicalize(config.serverSigningKeyset)) await saveAnchor(updated, store);
  return updated;
}

export async function acceptDemoSigningUpdate<T extends DemoSigningConfig>(config: T,
  value: unknown, deps: DemoSigningDependencies = {}): Promise<T> {
  const validate = await signingUpdateValidator();
  if (!validate(value)) failure('update_schema_invalid');
  const now = deps.now ?? new Date();
  const issued = Date.parse(value.issuedAt), expiry = Date.parse(value.expiresAt);
  if (value.organizationId !== config.organizationId || value.repositoryId !== config.repositoryId
    || value.deviceId !== config.deviceId || issued > now.getTime() + 30_000
    || expiry <= now.getTime() || expiry <= issued || expiry - issued > 5 * 60_000) failure('update_scope_or_expiry_invalid');
  return acceptDemoSigningKeysets(config, value.keysets, deps);
}
