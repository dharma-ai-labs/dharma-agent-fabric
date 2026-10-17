import {createHash, createPublicKey, randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {canonicalize, verifyInitialServerSigningKeyset, type SessionBindingScope} from '@dharma-ai-labs/agent-fabric-contracts';
import type {SecureSecretStore} from '@dharma-ai-labs/agent-fabric-secure-store';
import {loadDeviceConfig, loadDeviceEnrollmentAnchor} from './index.js';
import {HostOperationFence, type HostOperationScope} from './hostOperationScope.js';

export interface DeviceSigningRecoverySourceSelection {
  organizationId: string;
  workspaceId: string;
  repositoryBindingId: string;
  repositoryFingerprint: string;
  policyRevision: string;
  scopeDigest: string;
  contractDigest: string;
  sourceGenerationId: string;
  sourceReceiptId: string;
  sourceRevision: number;
  sourcePolicyRevision: string;
  sourcePolicyHash: string;
}
export interface DeviceSigningRecoverySessionSelection extends SessionBindingScope {
  sessionId: string;
  owner: 'dharma_bridge' | 'cooperative_session';
  createdAt: string;
}
export interface DeviceSigningRecoveryHostBinding {
  connectionId: string;
  hostContextId: string;
  threadId: string;
  turnId: string;
}
export interface DeviceSigningRecoveryPlanInput {
  configPath: string;
  source: DeviceSigningRecoverySourceSelection;
  session: DeviceSigningRecoverySessionSelection;
  hostBinding: DeviceSigningRecoveryHostBinding;
  hostScope: HostOperationScope;
  store?: SecureSecretStore;
  now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const DIGEST = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
const NATIVE_ID = /^[A-Za-z0-9_-]{1,128}$(?![\s\S])/;
const SOURCE_KEYS = ['organizationId', 'workspaceId', 'repositoryBindingId', 'repositoryFingerprint', 'policyRevision',
  'scopeDigest', 'contractDigest', 'sourceGenerationId', 'sourceReceiptId', 'sourceRevision', 'sourcePolicyRevision', 'sourcePolicyHash'];
const SESSION_KEYS = ['organizationId', 'repositoryBindingId', 'workspaceId', 'endpointId', 'membershipId', 'deviceId',
  'bindingId', 'provider', 'expiresAt', 'maximumProviderCostCents', 'sessionId', 'owner', 'createdAt'];
const HOST_KEYS = ['connectionId', 'hostContextId', 'threadId', 'turnId'];
const invalid = (): never => {throw Error('signing_recovery_local_context_invalid');};
function snapshot(value: unknown, keys: string[], numberKeys: string[] = []): Record<string, string | number> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)
    || Object.getOwnPropertySymbols(value).length) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).sort().join('\0') !== [...keys].sort().join('\0')) return invalid();
  const result: Record<string, string | number> = {};
  for (const key of keys) {
    const field = descriptors[key];
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return invalid();
    const item: unknown = field.value;
    if (typeof item !== (numberKeys.includes(key) ? 'number' : 'string')) return invalid();
    if (typeof item === 'string' && (item.length > 512 || /[\x00-\x1f\x7f]/.test(item))) return invalid();
    if (typeof item === 'number' && !Number.isSafeInteger(item)) return invalid();
    result[key] = item as string | number;
  }
  return result;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$(?![\s\S])/.test(value)) return invalid();
  const at = Date.parse(value); if (!Number.isFinite(at)) return invalid(); return at;
}
function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}
function domainHash(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(domain + '\0' + canonicalize(value)).digest('hex')}`;
}

/** Read-only context preparation, not possession, live authorization or recovery.
 * The owning host supplies already verified source/session selections and must
 * keep its scope current. No model/challenge fields may supply those records. */
export async function planDeviceSigningRecovery(input: DeviceSigningRecoveryPlanInput) {
  const scope = input.hostScope, fence = new HostOperationFence(scope);
  const configPath = input.configPath, store = input.store, clock = input.now ?? Date.now;
  try {
    const source = snapshot(input.source, SOURCE_KEYS, ['sourceRevision']);
    const session = snapshot(input.session, SESSION_KEYS, ['maximumProviderCostCents']);
    const hostBinding = snapshot(input.hostBinding, HOST_KEYS);
    await fence.assert();
    const now = clock();
    if (!Number.isFinite(now)) return invalid();
    for (const key of ['workspaceId', 'repositoryBindingId', 'sourceGenerationId']) if (!UUID.test(String(source[key]))) return invalid();
    for (const key of ['repositoryFingerprint', 'scopeDigest', 'contractDigest', 'sourcePolicyHash']) if (!DIGEST.test(String(source[key]))) return invalid();
    if (!/^org_[A-Za-z0-9]+$(?![\s\S])/.test(String(source.organizationId))
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/.test(String(source.policyRevision))
      || Number(source.sourceRevision) < 1 || Number(source.sourceRevision) > 2147483646
      || source.sourceReceiptId !== `repo_consent_${source.sourceGenerationId}`
      || source.sourcePolicyRevision !== `repository-source-${source.sourceGenerationId}`) return invalid();
    for (const key of ['endpointId', 'membershipId', 'deviceId', 'bindingId']) if (!UUID.test(String(session[key]))) return invalid();
    for (const key of ['organizationId', 'workspaceId', 'repositoryBindingId']) if (session[key] !== source[key]) return invalid();
    if (!['codex', 'claude', 'agy', 'hermes'].includes(String(session.provider))
      || !['dharma_bridge', 'cooperative_session'].includes(String(session.owner))
      || !NATIVE_ID.test(String(session.sessionId)) || Number(session.maximumProviderCostCents) < 0
      || timestamp(session.createdAt) > now || timestamp(session.expiresAt) <= now
      || !UUID.test(String(hostBinding.connectionId)) || !UUID.test(String(hostBinding.hostContextId))
      || !NATIVE_ID.test(String(hostBinding.threadId)) || !NATIVE_ID.test(String(hostBinding.turnId))
      || hostBinding.threadId !== session.sessionId) return invalid();
    const config = await fence.step(() => loadDeviceConfig(configPath));
    if (config.organizationId !== source.organizationId || config.deviceId !== session.deviceId
      || !config.hqUrl.startsWith('https://') || new URL(config.hqUrl).origin !== config.hqUrl
      || !UUID.test(config.installationId ?? '') || !UUID.test(config.setupClaimReference ?? '')
      || config.setupClaimRepositoryFingerprint !== source.repositoryFingerprint || !config.serverSigningKeyset) return invalid();
    const anchor = await loadDeviceEnrollmentAnchor({config, store, hostScope: scope, readOnly: true});
    const anchorKeys = ['schema', 'hqUrl', 'organizationId', 'deviceId', 'devicePublicKeyEd25519',
      'serverPublicKeyEd25519', 'serverSigningKeyset', 'enrolledAt'];
    if (Object.keys(anchor).sort().join('\0') !== [...anchorKeys].sort().join('\0')) return invalid();
    const previous = config.serverSigningKeyset, expiredAt = timestamp(previous.expiresAt);
    if (expiredAt > now || !Number.isSafeInteger(previous.generation) || previous.generation < 1) return invalid();
    const rootBytes = Buffer.from(config.serverPublicKeyEd25519, 'base64url');
    if (rootBytes.length !== 32 || rootBytes.toString('base64url') !== config.serverPublicKeyEd25519) return invalid();
    const deviceBytes = Buffer.from(config.publicKeyEd25519, 'base64url');
    if (deviceBytes.length !== 32 || deviceBytes.toString('base64url') !== config.publicKeyEd25519) return invalid();
    const root = createPublicKey({format: 'jwk', key: {kty: 'OKP', crv: 'Ed25519', x: config.serverPublicKeyEd25519}});
    const historicalSigner = previous.keys.find(key => key.keyVersion === previous.signedByKeyVersion);
    if (!historicalSigner || timestamp(historicalSigner.notBefore) >= expiredAt
      || timestamp(historicalSigner.notAfter) < expiredAt) return invalid();
    // Authenticate immutable historical bytes immediately before their expiry.
    // This never makes expired trust current or permits an ordinary update.
    if (!verifyInitialServerSigningKeyset(previous, root, config.organizationId, new Date(expiredAt - 1)).ok) return invalid();
    if (canonicalize(await fence.step(() => loadDeviceConfig(configPath))) !== canonicalize(config)) return invalid();
    const completedAt = clock();
    if (!Number.isFinite(completedAt) || completedAt < now || completedAt >= Math.min(now + 900_000, timestamp(session.expiresAt))) return invalid();
    await fence.assert();
    return Object.freeze({schema: 'dharma.device-signing-recovery-plan/v1' as const,
      planId: randomUUID(), authority: 'local_context_only_not_recovery_authorization' as const,
      preparedAt: new Date(now).toISOString(), expiresAt: new Date(Math.min(now + 900_000, timestamp(session.expiresAt))).toISOString(),
      origin: config.hqUrl, issuer: config.hqUrl, audience: 'dharma.agent-fabric.signing-recovery/v1' as const,
      organizationId: config.organizationId, recipientMembershipId: String(session.membershipId),
      deviceId: config.deviceId, installationId: config.installationId!, workspaceId: String(source.workspaceId),
      publicKeyEd25519: config.publicKeyEd25519, repositoryFingerprint: String(source.repositoryFingerprint),
      policyRevision: String(source.policyRevision), scopeDigest: String(source.scopeDigest), contractDigest: String(source.contractDigest),
      sourceSelectionDigest: domainHash('dharma.agent-fabric.signing-recovery-source-selection/v1',
        {...source, setupClaimReference: config.setupClaimReference}),
      nativeSessionBindingDigest: domainHash('dharma.agent-fabric.signing-recovery-native-session/v1',
        {session, hostBinding, installationId: config.installationId}),
      previousAnchorHash: hash(anchor), protectedConfigDigest: hash(config), previousGeneration: previous.generation,
      previousKeysetHash: hash(previous), previousRootFingerprint: `sha256:${createHash('sha256').update(rootBytes).digest('hex')}`});
  } catch {
    await fence.assert();
    return invalid();
  }
}
