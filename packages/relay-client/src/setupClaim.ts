import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {
  parseSetupClaimChallenge, setupClaimSigningPayload, openSetupClaimCredential, canonicalize,
  verifyInitialServerSigningKeyset, verifyServerSigningKeysetUpdate,
  type SetupClaimContext, type SetupClaimChallenge,
} from '@dharma-ai-labs/agent-fabric-contracts';
import { createSystemSecureStore, type SecureSecretStore } from '@dharma-ai-labs/agent-fabric-secure-store';
import {HostOperationFence, type HostOperationScope} from './hostOperationScope.js';
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
// Exact codes only: a character pattern would still let a token-shaped value through to stderr.
const SERVER_CODES = new Set([
  'setup_claim_approval_unavailable', 'setup_claim_client_unavailable', 'setup_claim_consume_unavailable',
  'setup_claim_credentials_unavailable', 'setup_claim_device_mismatch', 'setup_claim_expired',
  'setup_claim_proof_invalid', 'setup_claim_recipient_required', 'setup_claim_scope_unavailable',
  'setup_claim_unavailable', 'agent_fabric_capability_disabled', 'agent_fabric_decisions_not_ready',
  'agent_fabric_not_enabled', 'agent_fabric_retention_not_ready', 'agent_fabric_signing_expired',
  'agent_fabric_signing_not_ready', 'agent_fabric_signing_rotation_required', 'internal_error',
  'invalid_request', 'rate_limit_exceeded', 'rate_limit_unavailable', 'rate_limited']);

export type SetupClaimFailurePhase = 'input_validation' | 'store_preflight' | 'identity' | 'challenge'
  | 'signing' | 'finalize' | 'recipient_approval' | 'credential_validation' | 'credential_commit';
export type SetupClaimFailureReason = 'approval_expired' | 'server_rejected' | 'network_unavailable'
  | 'response_invalid' | 'canceled' | 'clock_skew' | 'credential_store_unavailable';
export interface SetupClaimFailureDiagnostic {
  schema: 'dharma.setup-claim-failure/v1';
  code: 'setup_claim_failed';
  phase: SetupClaimFailurePhase;
  reason?: SetupClaimFailureReason;
  serverCode?: string;
  correlationId?: string;
  /** With `clock_skew` only: measured server time minus this machine's time; positive means this clock is behind. */
  clockOffsetSeconds?: number;
}

/** The relay refuses a signed device request whose time is more than this far from its own clock. */
const RELAY_SIGNED_REQUEST_WINDOW_MS = 5 * 60_000;
/** A kept request signed longer ago than this is sent again only with a new time and signature (see index.ts). */
export const SIGNATURE_SENDABLE_MS = 4 * 60_000;
/** Network and handling time between a resend leaving this machine and the relay checking it. */
const SIGNED_REQUEST_LATENCY_MARGIN_MS = 15_000;
/** Setup corrects up to this much client clock error, measured from the challenge round trip. Later device
 * requests are signed on this machine's own clock and may be resent as signed for up to SIGNATURE_SENDABLE_MS,
 * so the offset setup accepts plus that age plus a latency margin stays inside the relay's window (45 s). */
export const SETUP_CLAIM_MAX_CLOCK_SKEW_MS = RELAY_SIGNED_REQUEST_WINDOW_MS - SIGNATURE_SENDABLE_MS
  - SIGNED_REQUEST_LATENCY_MARGIN_MS;
const MAX_REPORTED_OFFSET_SECONDS = 3_155_760_000; // 100 years; keeps the diagnostic schema-bounded.

function approximateDuration(seconds: number): string {
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? '' : 's'}`;
  // Seconds near the limit, so an offset just over it never reads as the limit itself.
  if (seconds < 600) return unit(seconds, 'second');
  if (seconds < 7_200) return unit(Math.round(seconds / 60), 'minute');
  if (seconds < 172_800) return unit(Math.round(seconds / 3_600), 'hour');
  return unit(Math.round(seconds / 86_400), 'day');
}

/** Fixed wording plus allowlisted fields only: never server text, approval URLs or caught errors. */
export function setupClaimFailureMessage(diagnostic: Readonly<SetupClaimFailureDiagnostic>): string | undefined {
  if (!diagnostic.reason) return undefined;
  const retry = 'Get a fresh setup prompt from Dharma and run it.';
  const offset = diagnostic.clockOffsetSeconds;
  const clock = Number.isSafeInteger(offset)
    ? `This computer's clock is about ${approximateDuration(Math.abs(offset!))} ${offset! > 0 ? 'behind' : 'ahead of'} Dharma's time`
    : `This computer's clock is too far from Dharma's time`;
  const text = {
    approval_expired: `Browser approval expired: setup did not receive an approval in time. ${retry}`,
    server_rejected: `Dharma rejected this setup${diagnostic.serverCode ? ` (${diagnostic.serverCode})` : ''}. ${retry} If it fails again, send Dharma this line.`,
    network_unavailable: `Could not reach Dharma. Check this machine's network connection. ${retry}`,
    response_invalid: `Dharma's setup response could not be verified. ${retry} If it fails again, send Dharma this line.`,
    canceled: `Setup was canceled before it finished. ${retry}`,
    clock_skew: `${clock}, more than setup corrects automatically (${approximateDuration(SETUP_CLAIM_MAX_CLOCK_SKEW_MS / 1_000)}). Turn on automatic date and time on this computer, then get a fresh setup prompt from Dharma and run it.`,
    credential_store_unavailable: `Setup could not use the Linux Secret Service, where it keeps this device's key. Install secret-tool (libsecret-tools on Debian/Ubuntu, libsecret on Fedora/Arch) and a Secret Service keyring such as gnome-keyring or KWallet, unlocked in your user session, which the relay service also uses. A desktop login provides one. On a host without one, run loginctl enable-linger $USER, then start and unlock the keyring on the user bus (DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus), and unlock it again after each reboot. ${retry}`,
  }[diagnostic.reason];
  return `${diagnostic.code} (${diagnostic.reason}): ${text}${diagnostic.correlationId ? ` Correlation ID: ${diagnostic.correlationId}.` : ''}`;
}

export interface ClaimSetupReferenceInput {
  hqUrl: string; organizationId: string; setupReference: string; recipientMembershipId: string;
  repositoryFingerprint: string; policyRevision: string; scopeDigest: string; contractDigest: string;
  name: string; platform: DeviceConfig['platform']; installationId?: string; configPath: string;
  existingConfig?: DeviceConfig | null; store?: SecureSecretStore; fetcher?: typeof fetch;
  now?: () => number; sleep?: (ms: number) => Promise<void>; maximumWaitMs?: number; pollIntervalMs?: number;
  onRecipientApprovalRequired?: (approval: BootstrapRecipientApproval) => Promise<void> | void;
  /** Owning host only; never derived from model arguments or cached approval.
   * Absence preserves the existing CLI claim path. Cancellation is cooperative. */
  hostScope?: HostOperationScope;
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
async function boundedJson(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (Number(response.headers.get('content-length')) > 65_536 || !response.body) return fail();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => {void reader.cancel().catch(() => undefined);};
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    if (signal?.aborted) {cancel(); return fail();}
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > 65_536) { await reader.cancel(); return fail(); }
      chunks.push(next.value);
    }
    if (signal?.aborted) return fail();
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
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
  let failureReason: SetupClaimFailureReason | undefined, serverCode: string | undefined, correlationId: string | undefined;
  let approvalDeadline: number | undefined, scopeSignal: AbortSignal | undefined, clockOffsetSeconds: number | undefined;
  const now = input.now ?? Date.now;
  // Server time minus local time, measured once from the challenge round trip. Every comparison with a
  // server-issued timestamp uses serverNow(); the local maximum wait (deadline) stays on the local clock.
  let clockOffsetMs = 0;
  const serverNow = () => now() + clockOffsetMs;
  try {
    const hqUrl = normalizeHqUrl(input.hqUrl);
    if (!hqUrl.startsWith('https:') || input.name.trim().length < 2 || input.name.length > 120
      || /[\x00-\x1f\x7f]/.test(input.name) || !['linux', 'wsl', 'macos', 'windows'].includes(input.platform)
      || !UUID.test(input.setupReference) || !UUID.test(input.recipientMembershipId)
      || !/^org_[A-Za-z0-9]+$/.test(input.organizationId)
      || ![input.repositoryFingerprint, input.scopeDigest, input.contractDigest].every(v => /^sha256:[a-f0-9]{64}$/.test(v))
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.policyRevision)) return fail();
    const maximumWaitMs = input.maximumWaitMs ?? 900_000;
    if (!Number.isFinite(maximumWaitMs) || maximumWaitMs < 1 || maximumWaitMs > 900_000) return fail();
    const deadline = now() + maximumWaitMs;
    const hostScope = input.hostScope;
    const hostFence = hostScope === undefined ? undefined : new HostOperationFence(hostScope);
    scopeSignal = hostFence?.signal;
    const assertScope = async () => {await hostFence?.assert();};
    const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
      await assertScope(); const result = await operation(); await assertScope(); return result;
    };
    const sleep = async (ms: number) => {
      await guarded(() => input.sleep ? input.sleep(ms) : delay(ms, undefined, {signal: scopeSignal}));
    };
    phase = 'store_preflight';
    const rawStore = await guarded(async () => input.store ?? await createSystemSecureStore());
    // Linux outside WSL needs an unlocked Secret Service through secret-tool; name it when the probe fails.
    if (rawStore.backend === 'linux-secret-service') failureReason = 'credential_store_unavailable';
    const store: SecureSecretStore = hostFence ? hostFence.store(rawStore) : rawStore;
    const probeAccount = `setup-claim-preflight-${randomBytes(16).toString('hex')}`;
    const probeValue = randomBytes(32).toString('base64url');
    try {
      await store.put(probeAccount, probeValue);
      if (await (store.getFresh ?? store.get).call(store, probeAccount) !== probeValue) return fail();
    } finally {
      // Only clean our random probe after cancellation; never delete identity
      // or partially installed credentials to pretend protected-store rollback.
      await rawStore.delete(probeAccount);
    }
    failureReason = undefined;
    await assertScope();
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
      await assertScope();
      const remaining = deadline - now(); if (remaining <= 0) return fail();
      serverCode = undefined; failureReason = 'network_unavailable';
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(30_000, remaining)));
      const requestSignal = scopeSignal ? AbortSignal.any([scopeSignal, timeout]) : timeout;
      const sentAt = now();
      const response = await fetcher(`${hqUrl}${PATH}`, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: requestSignal });
      failureReason = response.status >= 300 ? 'server_rejected' : undefined;
      const headerCorrelation = response.headers.get('x-dharma-correlation-id');
      if (headerCorrelation && UUID.test(headerCorrelation)) correlationId = headerCorrelation;
      await assertScope();
      if (response.redirected || (response.url && response.url !== `${hqUrl}${PATH}`)) return fail();
      const parsed = await boundedJson(response, requestSignal);
      const receivedAt = now();
      if (response.status >= 300) {
        const error = parsed.error as {code?: unknown; correlationId?: unknown} | null | undefined;
        if (typeof error?.code === 'string' && SERVER_CODES.has(error.code)) serverCode = error.code;
        if (typeof error?.correlationId === 'string' && UUID.test(error.correlationId)) correlationId = error.correlationId;
        if (![409,429].includes(response.status)) return fail();
      }
      await assertScope();
      return { response, body: parsed, sentAt, receivedAt };
    };
    phase = 'challenge';
    const initial = await send({ action: 'challenge', organizationId: input.organizationId,
      setupReference: input.setupReference, publicKeyEd25519: identity.publicKeyEd25519,
      credentialEncryptionPublicKey: expected.credentialEncryptionPublicKey, device });
    if (!initial.response.ok || initial.body.ok !== true
      || Object.keys(initial.body).sort().join(',') !== 'challenge,device,ok'
      || !sameDevice(initial.body.device, device)) return fail();
    // Validate the complete bound response at its own issue time first, so a mis-bound
    // challenge stays response_invalid whatever its timestamps say.
    const issuedAt = Date.parse(String(record(initial.body.challenge).issuedAt));
    parseSetupClaimChallenge(initial.body.challenge, expected, issuedAt);
    // The server stamped issuedAt between our send and receive, so the offset lies in
    // [issuedAt - receivedAt, issuedAt - sentAt]. Take the smallest correction in that range:
    // zero when the clocks already agree, never more than the round trip proves.
    clockOffsetMs = Math.max(issuedAt - initial.receivedAt, Math.min(0, issuedAt - initial.sentAt));
    if (!Number.isFinite(clockOffsetMs)) return fail();
    if (Math.abs(clockOffsetMs) > SETUP_CLAIM_MAX_CLOCK_SKEW_MS) {
      failureReason = 'clock_skew';
      // Rounded away from zero: a reported offset is never at or under the limit.
      clockOffsetSeconds = Math.sign(clockOffsetMs) * Math.min(MAX_REPORTED_OFFSET_SECONDS, Math.ceil(Math.abs(clockOffsetMs) / 1_000));
      return fail();
    }
    // The challenge window (at most 900 s) and expiry are still enforced, in server time.
    const challenge = parseSetupClaimChallenge(initial.body.challenge, expected, serverNow());
    // Keyset and key validity: the later of this clock and the corrected clock. The server's time can then
    // never make an expired key or keyset current again, and a key the server just made valid is accepted.
    // The approval check and the anchor write use the same rule.
    const keysetNow = () => new Date(Math.max(now(), serverNow()));
    phase = 'signing';
    await assertScope();
    const signature = sign(null, setupClaimSigningPayload(challenge), createPrivateKey({key: identity.privateJwk, format: 'jwk'})).toString('base64url');
    await assertScope();
    const request = { action: 'finalize', challenge, signature, device };
    let pending: BootstrapRecipientApproval | null = null;
    while (true) {
      phase = 'finalize';
      parseSetupClaimChallenge(challenge, expected, serverNow());
      const result = await send(request);
      parseSetupClaimChallenge(challenge, expected, serverNow());
      if (result.response.status === 429) {
        // Retry-After dates and the challenge expiry are server time; the local deadline is shifted into it.
        const wait = quotaRetryDelay(result.response, result.body, serverNow(),
          Math.min(deadline + clockOffsetMs, Date.parse(challenge.expiresAt)));
        await sleep(wait);
        continue;
      }
      if (result.response.status === 409 && result.body.ok === false
        && result.body.status === 'recipient_approval_required') {
        phase = 'recipient_approval'; failureReason = undefined;
        if (Object.keys(result.body).sort().join(',') !== 'approval,ok,status') return fail();
        const current = parseSetupClaimRecipientApproval(result.body.approval, challenge, signature, device, serverNow());
        // Local clock: the expiry is shifted out of server time.
        approvalDeadline = Math.min(deadline, Date.parse(challenge.expiresAt) - clockOffsetMs);
        if (!pending) { pending = current; await guarded(async () => {await input.onRecipientApprovalRequired?.(current);}); }
        else if (JSON.stringify(pending) !== JSON.stringify(current)) return fail();
        const remaining = approvalDeadline - now();
        if (remaining <= 0) return fail();
        await sleep(
          Math.min(Math.max(input.pollIntervalMs ?? 3_000, 250), 10_000, remaining));
        continue;
      }
      if (!result.response.ok || result.body.ok !== true || result.body.status !== 'approved'
        || Object.keys(result.body).sort().join(',') !== 'credential,ok,status') return fail();
      phase = 'credential_validation';
      await assertScope();
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
        ? verifyServerSigningKeysetUpdate(existing.serverSigningKeyset, approved.serverSigningKeyset!, keysetNow())
        : verifyInitialServerSigningKeyset(approved.serverSigningKeyset!, createPublicKey({format: 'jwk',
          key: { kty: 'OKP', crv: 'Ed25519', x: approved.serverPublicKeyEd25519 }}), input.organizationId, keysetNow());
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
        await assertScope();
        if (now() >= deadline) return fail();
        parseSetupClaimChallenge(challenge, expected, serverNow());
        await assertScope();
        const current = await (store.getFresh ?? store.get).call(store, identity.account);
        if (!current || canonicalize(JSON.parse(current)) !== canonicalize(identity.privateJwk)) return fail();
        if (now() >= deadline) return fail();
        parseSetupClaimChallenge(challenge, expected, serverNow());
      };
      phase = 'credential_commit';
      await assertCommit();
      await saveOrganizationApiToken({ hqUrl, organizationId: input.organizationId,
        installationId: input.installationId, token: approved.organizationApiToken, store });
      await assertCommit();
      await saveDeviceEnrollmentAnchor({config, store, hostScope, now: keysetNow()});
      await assertCommit();
      await saveDeviceConfig(input.configPath, config, {signal: scopeSignal ?? new AbortController().signal,
        current: async () => {await assertCommit(); return true;}});
      await assertCommit();
      return { config, scopes: [...SCOPES] };
    }
  } catch {
    // Observers cannot replace the original sanitized failure or authorize retries.
    try {
      // The approval wait ends locally: its deadline passes with no further request, so no server error exists.
      const approvalExpired = approvalDeadline !== undefined && (phase === 'finalize' || phase === 'recipient_approval')
        && (serverCode === 'setup_claim_expired' || (now() >= approvalDeadline && failureReason !== 'server_rejected'));
      const reason = scopeSignal?.aborted ? 'canceled' : approvalExpired ? 'approval_expired'
        : failureReason ?? (phase === 'challenge' || phase === 'finalize' ? 'response_invalid' : undefined);
      void Promise.resolve(input.onFailureDiagnostic?.(Object.freeze({
        schema: 'dharma.setup-claim-failure/v1', code: 'setup_claim_failed', phase,
        ...(reason ? {reason} : {}), ...(serverCode ? {serverCode} : {}), ...(correlationId ? {correlationId} : {}),
        ...(reason === 'clock_skew' && clockOffsetSeconds !== undefined ? {clockOffsetSeconds} : {}),
      }))).catch(() => undefined);
    } catch { /* Ignore local diagnostic observer failures. */ }
    return fail();
  }
}
