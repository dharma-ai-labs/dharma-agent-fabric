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
interface EnrollmentApproval {
  schema: 'dharma.demo-enrollment-approval/v1'; organizationId: string; repositoryId: string;
  participantId: string; deviceId: string; enrollmentId: string; publicKeyEd25519: string;
  approvedAt: string; expiresAt: string;
}
type Anchor = ReturnType<typeof binding> & { serverSigningKeyset: TrustedServerSigningKeyset; nextKeyVersion: string | null };
interface Recovery {
  schema: 'dharma.demo-signing-recovery/v1'; previousAnchorHash: string;
  previousWasProtected: boolean; replacementAnchor: string; approval: EnrollmentApproval;
}
let approvalValidator: Promise<ValidateFunction<EnrollmentApproval>> | undefined;
function enrollmentApprovalValidator() {
  return approvalValidator ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const addFormats = createRequire(import.meta.url)('ajv-formats').default as FormatsPlugin;
    addFormats(ajv);
    return ajv.compile<EnrollmentApproval>(JSON.parse(await readFile(
      new URL('./schemas/demo-enrollment-approval.schema.json', import.meta.url), 'utf8')));
  })();
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
async function saveAnchor(config: DemoSigningConfig, store: SecureSecretStore, nextKeyVersion: string | null) {
  const serialized = canonicalize({ ...binding(config), serverSigningKeyset: config.serverSigningKeyset, nextKeyVersion });
  const account = accountFor(config);
  await store.put(account, serialized);
  if (await readProtected(store, account) !== serialized) failure('secure_store_write_not_confirmed');
}

function readProtected(store: SecureSecretStore, account: string) {
  return store.getFresh ? store.getFresh(account) : store.get(account);
}

function parseAnchor(serialized: string): Anchor {
  let anchor: Anchor;
  try { anchor = JSON.parse(serialized); }
  catch { failure('protected_anchor_malformed'); }
  if (!anchor || typeof anchor !== 'object' || !anchor.serverSigningKeyset
    || !validateTrustedServerSigningKeysetContract(anchor.serverSigningKeyset).ok) failure('protected_anchor_malformed');
  return anchor;
}
function anchorBinding(anchor: Anchor) {
  const { serverSigningKeyset: _keyset, nextKeyVersion: _next, ...base } = anchor;
  return base;
}
function checkDiskHead(config: DemoSigningConfig, keyset: TrustedServerSigningKeyset) {
  if (!config.serverSigningKeyset || !validateTrustedServerSigningKeysetContract(config.serverSigningKeyset).ok
    || config.serverSigningKeyset.generation > keyset.generation
    || (config.serverSigningKeyset.generation === keyset.generation
      && canonicalize(config.serverSigningKeyset) !== canonicalize(keyset))) failure('protected_anchor_conflict');
}
function hashAnchor(serialized: string) { return createHash('sha256').update(serialized).digest('hex'); }
async function parseRecovery(serialized: string): Promise<Recovery> {
  let recovery: Recovery;
  try { recovery = JSON.parse(serialized); }
  catch { failure('protected_recovery_malformed'); }
  if (recovery?.schema !== 'dharma.demo-signing-recovery/v1'
    || !/^[0-9a-f]{64}$/.test(recovery.previousAnchorHash)
    || typeof recovery.previousWasProtected !== 'boolean'
    || typeof recovery.replacementAnchor !== 'string'
    || !(await enrollmentApprovalValidator())(recovery.approval)) failure('protected_recovery_malformed');
  return recovery;
}
async function boundAnchor<T extends DemoSigningConfig>(config: T, serialized: string, store: SecureSecretStore) {
  const anchor = parseAnchor(serialized);
  if (canonicalize(anchorBinding(anchor)) === canonicalize(binding(config))) {
    checkDiskHead(config, anchor.serverSigningKeyset);
    return { config, anchor };
  }
  // Only a confirmed OS-store journal may bridge an interrupted pin replacement.
  // A disk intent or an expired self-signature cannot authorize that replacement.
  const journal = await readProtected(store, `${accountFor(config)}-recovery`);
  if (!journal) failure('protected_anchor_binding_mismatch');
  const recovery = await parseRecovery(journal);
  const replacement = parseAnchor(recovery.replacementAnchor);
  const previous = await readProtected(store, `${accountFor(config)}-history-${recovery.previousAnchorHash}`);
  if (!previous || hashAnchor(previous) !== recovery.previousAnchorHash
    || canonicalize(anchorBinding(parseAnchor(previous))) !== canonicalize(binding(config))
    || canonicalize(anchorBinding(replacement)) !== canonicalize(anchorBinding(anchor))) failure('protected_anchor_binding_mismatch');
  checkDiskHead(config, parseAnchor(previous).serverSigningKeyset);
  checkDiskHead({ ...config, serverSigningKeyset: replacement.serverSigningKeyset }, anchor.serverSigningKeyset);
  return { config: { ...config, serverPublicKeyEd25519: replacement.serverPublicKeyEd25519,
    serverSigningKeyset: replacement.serverSigningKeyset }, anchor };
}

export async function resolveDemoSigningTrust<T extends DemoSigningConfig>(config: T,
  deps: DemoSigningDependencies = {}): Promise<T> {
  const now = deps.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || !/^[A-Za-z0-9_-]{43}$/.test(config.serverPublicKeyEd25519 ?? '')
    || !config.serverSigningKeyset) failure('missing_enrollment_trust');
  const store = deps.store ?? await createSystemSecureStore();
  const serialized = await readProtected(store, accountFor(config));
  if (!serialized) {
    // Compatibility migration is allowed only while the originally pinned
    // bootstrap is valid. An expired or already-rotated disk file cannot bootstrap.
    checkKeyset(config.serverSigningKeyset, config.organizationId, now, config.serverPublicKeyEd25519);
    await saveAnchor(config, store, null);
    return config;
  }
  const bound = await boundAnchor(config, serialized, store);
  const { serverSigningKeyset, nextKeyVersion } = bound.anchor;
  if (nextKeyVersion !== null && (typeof nextKeyVersion !== 'string'
    || !serverSigningKeyset.keys.some(k => k.keyVersion === nextKeyVersion && k.status === 'overlap'))) failure('protected_preload_invalid');
  checkKeyset(serverSigningKeyset, config.organizationId, now);
  return { ...bound.config, serverSigningKeyset };
}

// Call only from a successful poll of the browser-approved enrollment, under the
// device operation lock. The receipt is not a grant and cannot approve a device.
export async function recoverDemoSigningEnrollment<T extends DemoSigningConfig>(config: T,
  trust: Pick<DemoSigningConfig, 'serverPublicKeyEd25519' | 'serverSigningKeyset'>,
  value: unknown, deps: DemoSigningDependencies = {}): Promise<T> {
  const validate = await enrollmentApprovalValidator();
  if (!validate(value)) failure('fresh_approval_required');
  const now = deps.now ?? new Date();
  const approved = Date.parse(value.approvedAt), expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(now.getTime()) || value.organizationId !== config.organizationId
    || value.repositoryId !== config.repositoryId || value.deviceId !== config.deviceId
    || value.publicKeyEd25519 !== config.publicKeyEd25519 || approved > now.getTime() + 30_000
    || expiry <= now.getTime() || expiry <= approved || expiry - approved > 15 * 60_000) failure('approval_scope_or_expiry_invalid');
  const store = deps.store ?? await createSystemSecureStore();
  const account = accountFor(config);
  const priorJournal = await readProtected(store, `${account}-recovery`);
  const prior = priorJournal === null ? null : await parseRecovery(priorJournal);
  let existing = await readProtected(store, account);
  // Windows PasswordVault removes an existing credential before adding its
  // replacement. Resume that interrupted write only from the confirmed journal.
  if (existing === null && prior?.previousWasProtected) {
    if (canonicalize(prior.approval) !== canonicalize(value)
      || await readProtected(store, `${account}-approval-${value.enrollmentId}`) !== canonicalize(prior)) {
      failure('approval_replayed_or_conflicting');
    }
    const previous = await readProtected(store, `${account}-history-${prior.previousAnchorHash}`);
    if (!previous || hashAnchor(previous) !== prior.previousAnchorHash
      || canonicalize(anchorBinding(parseAnchor(previous))) !== canonicalize(binding(config))) {
      failure('protected_anchor_binding_mismatch');
    }
    existing = previous;
  }
  const bound = existing ? await boundAnchor(config, existing, store) : null;
  const head = bound?.anchor.serverSigningKeyset ?? config.serverSigningKeyset;
  if (!head || !trust.serverSigningKeyset || !trust.serverPublicKeyEd25519) failure('missing_enrollment_trust');
  const expiredAt = Date.parse(head.expiresAt);
  if (!Number.isFinite(expiredAt) || expiredAt > now.getTime() || approved <= expiredAt) failure('approval_must_follow_trust_expiry');
  checkKeyset(head, config.organizationId, new Date(expiredAt - 1), existing ? undefined : config.serverPublicKeyEd25519);
  checkKeyset(trust.serverSigningKeyset, config.organizationId, now, trust.serverPublicKeyEd25519);
  for (const old of head.keys) {
    const retained = trust.serverSigningKeyset.keys.find(key => key.keyVersion === old.keyVersion);
    if (retained && (retained.publicKeyEd25519 !== old.publicKeyEd25519
      || retained.notBefore !== old.notBefore || retained.notAfter !== old.notAfter)) failure('retained_window_changed');
  }
  if (trust.serverSigningKeyset.generation <= head.generation
    || Date.parse(trust.serverSigningKeyset.expiresAt) <= now.getTime() + 600_000
    || Date.parse(trust.serverSigningKeyset.expiresAt) - Date.parse(trust.serverSigningKeyset.issuedAt) > 29 * 86_400_000) failure('reenrollment_generation_or_lifetime_invalid');
  const updated = { ...(bound?.config ?? config), ...trust };
  const replacementAnchor = canonicalize({ ...binding(updated), serverSigningKeyset: updated.serverSigningKeyset, nextKeyVersion: null });
  // Legacy clients without an OS signing anchor retain a labelled historical
  // snapshot; only the new recipient approval establishes its replacement trust.
  const previous = existing ?? canonicalize({ ...binding(config), serverSigningKeyset: head, nextKeyVersion: null });
  const previousAnchorHash = hashAnchor(previous);
  const recovery: Recovery = { schema: 'dharma.demo-signing-recovery/v1', previousAnchorHash, previousWasProtected: existing !== null,
    replacementAnchor, approval: structuredClone(value) };
  if (prior) {
    if (prior.approval.participantId !== value.participantId
      || (prior.approval.enrollmentId === value.enrollmentId
        && canonicalize(prior) !== canonicalize(recovery))) failure('approval_replayed_or_conflicting');
  }
  const archive = `${account}-history-${previousAnchorHash}`;
  const archived = await readProtected(store, archive);
  if (archived !== null && archived !== previous) failure('protected_history_conflict');
  const approvalAccount = `${account}-approval-${value.enrollmentId}`;
  const recoveryRecord = canonicalize(recovery);
  const seen = await readProtected(store, approvalAccount);
  if (seen !== null && seen !== recoveryRecord) failure('approval_replayed_or_conflicting');
  const confirm = async (key: string, contents: string) => {
    await store.put(key, contents);
    if (await readProtected(store, key) !== contents) failure('secure_store_write_not_confirmed');
  };
  if (archived === null) await confirm(archive, previous);
  if (seen === null) await confirm(approvalAccount, recoveryRecord);
  await confirm(`${account}-recovery`, recoveryRecord);
  await confirm(account, replacementAnchor);
  return updated;
}

// Callers hold the existing per-device operation lock. The protected anchor is
// the write-ahead record; a restart repairs an older disk config from this record.
export async function acceptDemoSigningKeysets<T extends DemoSigningConfig>(config: T,
  chain: TrustedServerSigningKeyset[], deps: DemoSigningDependencies = {}): Promise<T> {
  if (!Array.isArray(chain) || chain.length > 20) failure('chain_limit');
  const now = deps.now ?? new Date();
  const store = deps.store ?? await createSystemSecureStore();
  let updated = await resolveDemoSigningTrust(config, { ...deps, store, now });
  let nextKeyVersion = (JSON.parse((await readProtected(store, accountFor(config)))!) as { nextKeyVersion: string | null }).nextKeyVersion;
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
      if (nextKeyVersion !== null || introduced.length !== 1 || introduced[0]!.status !== 'overlap'
        || Date.parse(introduced[0]!.notBefore) > now.getTime()
        || Date.parse(introduced[0]!.notAfter) <= now.getTime() + 600_000
        || candidate.keys.length !== current.keys.length + 1
        || current.keys.some(old => candidate.keys.find(k => k.keyVersion === old.keyVersion)!.status !== old.status)) {
        failure('preload_invalid');
      }
      nextKeyVersion = introduced[0]!.keyVersion;
    } else {
      if (active.keyVersion !== nextKeyVersion || introduced.length !== 0
        || current.keys.find(k => k.keyVersion === active.keyVersion)?.status !== 'overlap'
        || candidate.keys.length !== current.keys.length
        || current.keys.some(old => candidate.keys.find(k => k.keyVersion === old.keyVersion)!.status
          !== (old.keyVersion === active.keyVersion ? 'active' : old.keyVersion === previousActive.keyVersion ? 'overlap' : old.status))) {
        failure('activation_without_preload');
      }
      nextKeyVersion = null;
    }
    updated = { ...updated, serverSigningKeyset: structuredClone(candidate) };
  }
  if (canonicalize(updated.serverSigningKeyset) !== canonicalize(config.serverSigningKeyset)) await saveAnchor(updated, store, nextKeyVersion);
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
