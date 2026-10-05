import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import {
  parseSetupClaimChallenge, setupClaimSigningPayload, openSetupClaimCredential, canonicalize,
  verifyInitialServerSigningKeyset, verifyServerSigningKeysetUpdate,
  type SetupClaimContext, type SetupClaimChallenge,
} from '@dharma-ai-labs/agent-fabric-contracts';
import { createSystemSecureStore, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';
import {
  loadOrCreateDeviceIdentity, normalizeHqUrl, normalizeRelayUrl, saveDeviceConfig,
  saveDeviceEnrollmentAnchor, saveOrganizationApiToken,
  type DeviceConfig, type BootstrapEnrollmentResult, type BootstrapRecipientApproval,
} from './index.js';

const PATH = '/api/v1/agent-fabric/bootstrap/setup-claim';
const SCOPES = ['agents:read', 'agents:run', 'evals:read', 'evals:run', 'traces:read', 'skills:read',
  'skills:write', 'usage:read', 'reports:read', 'fabric:devices', 'fabric:tasks'];
const fail = (): never => { throw new Error('setup_claim_failed'); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SetupClaimFailurePhase = 'input_validation' | 'store_preflight' | 'identity' | 'challenge'
  | 'signing' | 'finalize' | 'recipient_approval' | 'credential_validation' | 'credential_commit';
export interface SetupClaimFailureDiagnostic {
  schema: 'dharma.setup-claim-failure/v1';
  code: 'setup_claim_failed';
  phase: SetupClaimFailurePhase;
}

export interface ClaimSetupReferenceInput {
  hqUrl: string; organizationId: string; setupReference: string; recipientMembershipId: string;
  repositoryFingerprint: string; policyRevision: string; scopeDigest: string; contractDigest: string;
  name: string; platform: DeviceConfig['platform']; installationId?: string; configPath: string;
  existingConfig?: DeviceConfig | null; store?: SecureSecretStore; fetcher?: typeof fetch;
  now?: () => number; sleep?: (ms: number) => Promise<void>; maximumWaitMs?: number; pollIntervalMs?: number;
  onRecipientApprovalRequired?: (approval: BootstrapRecipientApproval) => Promise<void> | void;
  /** Local phase observation only: no vendor exception, response body, or retry authority. */
  onFailureDiagnostic?: (diagnostic: Readonly<SetupClaimFailureDiagnostic>) => void;
}

/** Never apply one repository's public claim reference to a legacy sibling.
 * The server must independently validate this signed request's exact row. */
export function setupClaimSourceRegistration(config: Pick<DeviceConfig,
  'setupClaimReference' | 'setupClaimRepositoryFingerprint'>, repositoryFingerprint: string): {setupClaimReference?: string} {
  if (config.setupClaimRepositoryFingerprint !== repositoryFingerprint) return {};
  if (!/^sha256:[a-f0-9]{64}$/.test(repositoryFingerprint) || !UUID.test(config.setupClaimReference ?? '')) return fail();
  return { setupClaimReference: config.setupClaimReference };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (Number(response.headers.get('content-length')) > 65_536 || !response.body) return fail();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > 65_536) { await reader.cancel(); return fail(); }
      chunks.push(next.value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { reader.releaseLock(); }
}
function sameDevice(value: unknown, expected: {name: string; platform: string}): boolean {
  const device = record(value);
  return Object.keys(device).sort().join(',') === 'name,platform'
    && device.name === expected.name && device.platform === expected.platform;
}
function quotaRetryDelay(response: Response, body: Record<string, unknown>, now: number, deadline: number): number {
  const error = record(body.error);
  const retryAfter = response.headers.get('retry-after');
  if (response.status !== 429 || body.ok !== false
    || !['rate_limited', 'rate_limit_exceeded'].includes(String(error.code))
    || !retryAfter || retryAfter.length > 64) return fail();
  let milliseconds: number;
  if (/^\d{1,6}$/.test(retryAfter)) milliseconds = Number(retryAfter) * 1_000;
  else {
    const timestamp = Date.parse(retryAfter);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== retryAfter) return fail();
    milliseconds = timestamp - now;
  }
  milliseconds = Math.max(milliseconds, 250);
  if (!Number.isFinite(milliseconds) || milliseconds >= deadline - now) return fail();
  return milliseconds;
}
export function parseSetupClaimRecipientApproval(value: unknown, challenge: SetupClaimChallenge, signature: string,
  device: {name: string; platform: string}, now: number): BootstrapRecipientApproval {
  const body = record(value); const uri = new URL(String(body.url));
  if (Object.keys(body).sort().join(',') !== 'expiresAt,fingerprint,repositoryFingerprint,url') return fail();
  const encoded = /^#request=([A-Za-z0-9_-]{1,16384})$/.exec(uri.hash)?.[1];
  if (!encoded) return fail();
  const requestBytes = Buffer.from(encoded, 'base64url');
  if (requestBytes.toString('base64url') !== encoded
    || canonicalize(JSON.parse(requestBytes.toString('utf8'))) !== canonicalize({challenge, signature, device})) return fail();
  const fingerprint = `sha256:${createHash('sha256').update(Buffer.from(challenge.publicKeyEd25519, 'base64url')).digest('hex')}`;
  if (uri.origin !== challenge.origin || uri.username || uri.password || uri.search
    || uri.pathname !== '/portal/agent-fabric/setup-claim-approval'
    || body.expiresAt !== challenge.expiresAt || Date.parse(String(body.expiresAt)) <= now
    || body.fingerprint !== fingerprint || body.repositoryFingerprint !== challenge.repositoryFingerprint) return fail();
  return { url: uri.toString(), expiresAt: challenge.expiresAt, fingerprint,
    repositoryFingerprint: challenge.repositoryFingerprint };
}

/** Non-TTY native enrollment. Credential plaintext never leaves this method;
 * only the existing protected store receives it. Network errors are never reflected. */
export async function claimSetupReference(input: ClaimSetupReferenceInput): Promise<{config: DeviceConfig; scopes: string[]}> {
  let phase: SetupClaimFailurePhase = 'input_validation';
  try {
    const hqUrl = normalizeHqUrl(input.hqUrl);
    if (!hqUrl.startsWith('https:') || input.name.trim().length < 2 || input.name.length > 120
      || /[\x00-\x1f\x7f]/.test(input.name) || !['linux', 'wsl', 'macos', 'windows'].includes(input.platform)
      || !UUID.test(input.setupReference) || !UUID.test(input.recipientMembershipId)
      || !/^org_[A-Za-z0-9]+$/.test(input.organizationId)
      || ![input.repositoryFingerprint, input.scopeDigest, input.contractDigest].every(v => /^sha256:[a-f0-9]{64}$/.test(v))
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.policyRevision)) return fail();
    const now = input.now ?? Date.now;
    const maximumWaitMs = input.maximumWaitMs ?? 900_000;
    if (!Number.isFinite(maximumWaitMs) || maximumWaitMs < 1 || maximumWaitMs > 900_000) return fail();
    const deadline = now() + maximumWaitMs;
    phase = 'store_preflight';
    const store = input.store ?? await createSystemSecureStore();
    const probeAccount = `setup-claim-preflight-${randomBytes(16).toString('hex')}`;
    const probeValue = randomBytes(32).toString('base64url');
    try {
      await store.put(probeAccount, probeValue);
      if (await (store.getFresh ?? store.get).call(store, probeAccount) !== probeValue) return fail();
    } finally { await store.delete(probeAccount); }
    // Existing protected identity access fails before challenge/approval/effects.
    phase = 'identity';
    const identity = await loadOrCreateDeviceIdentity({ hqUrl, organizationId: input.organizationId,
      installationId: input.installationId, store });
    const existing = input.existingConfig;
    if (existing && (existing.organizationId !== input.organizationId || normalizeHqUrl(existing.hqUrl) !== hqUrl
      || existing.publicKeyEd25519 !== identity.publicKeyEd25519 || existing.installationId !== input.installationId)) return fail();
    const encryption = generateKeyPairSync('x25519');
    const expected: SetupClaimContext = {
      origin: hqUrl, setupReference: input.setupReference, organizationId: input.organizationId,
      recipientMembershipId: input.recipientMembershipId, publicKeyEd25519: identity.publicKeyEd25519,
      credentialEncryptionPublicKey: encryption.publicKey.export({format: 'jwk'}).x!,
      repositoryFingerprint: input.repositoryFingerprint, mode: 'source', policyRevision: input.policyRevision,
      scopeDigest: input.scopeDigest, contractDigest: input.contractDigest,
    };
    const device = { name: input.name, platform: input.platform };
    const fetcher = input.fetcher ?? fetch;
    const send = async (body: unknown) => {
      const remaining = deadline - now(); if (remaining <= 0) return fail();
      const response = await fetcher(`${hqUrl}${PATH}`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, remaining))) });
      if (response.redirected || (response.url && response.url !== `${hqUrl}${PATH}`)
        || response.status >= 300 && ![409,429].includes(response.status)) return fail();
      return { response, body: await boundedJson(response) };
    };
    phase = 'challenge';
    const initial = await send({ action: 'challenge', organizationId: input.organizationId,
      setupReference: input.setupReference, publicKeyEd25519: identity.publicKeyEd25519,
      credentialEncryptionPublicKey: expected.credentialEncryptionPublicKey, device });
    if (!initial.response.ok || initial.body.ok !== true
      || Object.keys(initial.body).sort().join(',') !== 'challenge,device,ok'
      || !sameDevice(initial.body.device, device)) return fail();
    const localNow = now();
    const issuedAt = Date.parse(String(record(initial.body.challenge).issuedAt));
    if (issuedAt > localNow) {
      if (issuedAt - localNow > 5_000 || issuedAt >= deadline) return fail();
      // Validate the complete bound response before waiting. Do not adjust the
      // clock or relax the strict issued-at/expiry checks used by every effect.
      parseSetupClaimChallenge(initial.body.challenge, expected, issuedAt);
      await (input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(issuedAt - localNow);
      if (now() >= deadline) return fail();
    }
    const challenge = parseSetupClaimChallenge(initial.body.challenge, expected, now());
    phase = 'signing';
    const signature = sign(null, setupClaimSigningPayload(challenge), createPrivateKey({key: identity.privateJwk, format: 'jwk'})).toString('base64url');
    const request = { action: 'finalize', challenge, signature, device };
    let pending: BootstrapRecipientApproval | null = null;
    while (true) {
      phase = 'finalize';
      parseSetupClaimChallenge(challenge, expected, now());
      const result = await send(request);
      parseSetupClaimChallenge(challenge, expected, now());
      if (result.response.status === 429) {
        const wait = quotaRetryDelay(result.response, result.body, now(), Math.min(deadline, Date.parse(challenge.expiresAt)));
        await (input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(wait);
        continue;
      }
      if (result.response.status === 409 && result.body.ok === false
        && result.body.status === 'recipient_approval_required') {
        phase = 'recipient_approval';
        if (Object.keys(result.body).sort().join(',') !== 'approval,ok,status') return fail();
        const current = parseSetupClaimRecipientApproval(result.body.approval, challenge, signature, device, now());
        if (!pending) { pending = current; await input.onRecipientApprovalRequired?.(current); }
        else if (JSON.stringify(pending) !== JSON.stringify(current)) return fail();
        const remaining = Math.min(deadline, Date.parse(challenge.expiresAt)) - now();
        if (remaining <= 0) return fail();
        await (input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(
          Math.min(Math.max(input.pollIntervalMs ?? 3_000, 250), 10_000, remaining));
        continue;
      }
      if (!result.response.ok || result.body.ok !== true || result.body.status !== 'approved'
        || Object.keys(result.body).sort().join(',') !== 'credential,ok,status') return fail();
      phase = 'credential_validation';
      const enrolled = record(JSON.parse(openSetupClaimCredential(challenge, result.body.credential, encryption.privateKey)));
      for (const key of ['organizationId', 'setupReference', 'recipientMembershipId', 'publicKeyEd25519',
        'repositoryFingerprint', 'scopeDigest', 'contractDigest'] as const) if (enrolled[key] !== challenge[key]) return fail();
      const scopes = enrolled.organizationApiTokenScopes;
      if (enrolled.ok !== true || enrolled.status !== 'approved' || !UUID.test(String(enrolled.deviceId))
        || typeof enrolled.organizationApiToken !== 'string' || !/^dharma_org_[A-Za-z0-9_-]{40,120}$/.test(enrolled.organizationApiToken)
        || !Array.isArray(scopes) || scopes.length !== SCOPES.length
        || [...scopes].sort().join('\0') !== [...SCOPES].sort().join('\0')
        || typeof enrolled.serverPublicKeyEd25519 !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(enrolled.serverPublicKeyEd25519)
        || !enrolled.serverSigningKeyset) return fail();
      const approved = enrolled as unknown as BootstrapEnrollmentResult;
      if (existing && (existing.deviceId !== approved.deviceId || existing.serverPublicKeyEd25519 !== approved.serverPublicKeyEd25519)) return fail();
      const unchangedKeyset = existing?.serverSigningKeyset
        && canonicalize(existing.serverSigningKeyset) === canonicalize(approved.serverSigningKeyset);
      const verified = existing?.serverSigningKeyset && !unchangedKeyset
        ? verifyServerSigningKeysetUpdate(existing.serverSigningKeyset, approved.serverSigningKeyset!, new Date(now()))
        : verifyInitialServerSigningKeyset(approved.serverSigningKeyset!, createPublicKey({format: 'jwk',
          key: { kty: 'OKP', crv: 'Ed25519', x: approved.serverPublicKeyEd25519 }}), input.organizationId, new Date(now()));
      if (!verified.ok) return fail();
      const relayUrl = normalizeRelayUrl(approved.relayUrl);
      const config: DeviceConfig = { schema: 'dharma.device-config/v1', hqUrl, organizationId: input.organizationId,
        ...(input.installationId ? {installationId: input.installationId} : {}), deviceId: approved.deviceId,
        deviceName: input.name, platform: input.platform, publicKeyEd25519: identity.publicKeyEd25519,
        serverPublicKeyEd25519: approved.serverPublicKeyEd25519, serverSigningKeyset: approved.serverSigningKeyset,
        relayUrl, enrolledAt: existing?.enrolledAt ?? new Date(now()).toISOString(),
        setupClaimReference: challenge.setupReference, setupClaimRepositoryFingerprint: challenge.repositoryFingerprint };
      // Each effect is fenced by the live challenge and a readonly fresh key
      // check. Never recreate a missing/changed identity during commit.
      // The protected store and public config file are not a single transaction:
      // interruption preserves partial protected writes for same-key recovery.
      const assertCommit = async () => {
        if (now() >= deadline) return fail();
        parseSetupClaimChallenge(challenge, expected, now());
        const current = await (store.getFresh ?? store.get).call(store, identity.account);
        if (!current || canonicalize(JSON.parse(current)) !== canonicalize(identity.privateJwk)) return fail();
        if (now() >= deadline) return fail();
        parseSetupClaimChallenge(challenge, expected, now());
      };
      phase = 'credential_commit';
      await assertCommit();
      await saveOrganizationApiToken({ hqUrl, organizationId: input.organizationId,
        installationId: input.installationId, token: approved.organizationApiToken, store });
      await assertCommit();
      await saveDeviceEnrollmentAnchor({ config, store });
      await assertCommit();
      await saveDeviceConfig(input.configPath, config);
      await assertCommit();
      return { config, scopes: [...SCOPES] };
    }
  } catch {
    // Observers cannot replace the original sanitized failure or authorize retries.
    try {
      void Promise.resolve(input.onFailureDiagnostic?.(Object.freeze({
        schema: 'dharma.setup-claim-failure/v1', code: 'setup_claim_failed', phase,
      }))).catch(() => undefined);
    } catch { /* Ignore local diagnostic observer failures. */ }
    return fail();
  }
}
