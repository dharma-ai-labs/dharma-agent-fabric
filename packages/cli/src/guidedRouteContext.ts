import { createPublicKey, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256, validateContract, verifyCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';
import { isSupportedNodeVersion } from './runtime-bootstrap.js';

type Binding = { id: string; sourceFingerprint: string; packageState: 'published'; manifestHash: string; catalogHash: string };
type Context = { schema: string; contextId: string; organizationId: string; recipientMembershipId: string; hqOrigin: string;
  membershipStatus: 'active'; roleRevision: number; roleName: string; policyRevision: string; provider: 'codex'; sessionId: string;
  clientPlatform: 'linux'; clientTransport: 'named_session';
  deviceId: string | null; issuedAt: string; expiresAt: string; allowedModes: string[]; bindings: Binding[]; signature: string };
type Expected = { hqOrigin: string; organizationId: string; recipientMembershipId: string; roleRevision: number;
  policyRevision: string; bindingId: string; sourceFingerprint: string; manifestHash: string; catalogHash: string;
  provider: string; clientPlatform: string; clientTransport: string; sessionId: string; publicKeyEd25519: string; enrollmentDeviceId: string | null };
const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

/** Candidate read-only driver seam, NOT an issuer or enrollment authority.
 * The caller must independently obtain the expected recipient, assigned role,
 * policy and public key through its supported authenticated context loader.
 * No loader/CLI wiring is implied by accepting a synthetic signed fixture. */
export async function prepareGuidedRouteContext(input: {
  context: unknown; expected: Expected; mode: string; nodeVersion: string; interactive: boolean; now?: Date;
}) {
  const now = input.now ?? new Date();
  const blocked = (code: string) => ({ schema: 'dharma.guided-route-plan/v1' as const, operationId: randomUUID(),
    ok: false, stage: 'blocked' as 'blocked' | 'plan', code, effects: false as const, ready: false as const,
    enrollmentStarted: false as const, authorityVerified: false as const, organizationId: null as string | null,
    bindingId: null as string | null, roleRevision: null as number | null, contextHash: null as string | null,
    nextAction: null as string | null, requiresSourceCheckout: null as boolean | null, initializesEmptyGit: false,
    createdAt: Number.isFinite(now.getTime()) ? now.toISOString() : null,
    expiresAt: null as string | null });
  if (!Number.isFinite(now.getTime())) return blocked('guided_route_context_invalid');
  if (!isSupportedNodeVersion(input.nodeVersion)) return blocked('guided_route_runtime_unsupported');
  if (!input.interactive) return blocked('guided_route_interactive_required');
  if (input.expected.provider !== 'codex') return blocked('guided_route_provider_unqualified');
  if (input.expected.clientPlatform !== 'linux' || input.expected.clientTransport !== 'named_session') {
    return blocked('guided_route_client_unqualified');
  }
  try {
    const expected = input.expected, origin = new URL(expected.hqOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== expected.hqOrigin || origin.username || origin.password
      || !/^org_[A-Za-z0-9_]{1,120}$/.test(expected.organizationId) || !uuid(expected.recipientMembershipId)
      || !uuid(expected.bindingId) || !Number.isSafeInteger(expected.roleRevision) || expected.roleRevision < 1
      || [expected.sourceFingerprint, expected.manifestHash, expected.catalogHash].some(v => !/^sha256:[a-f0-9]{64}$/.test(v))
      || !expected.policyRevision || expected.policyRevision.length > 160 || !expected.sessionId || expected.sessionId.length > 160
      || !/^[A-Za-z0-9_-]{43}$/.test(expected.publicKeyEd25519)
      || expected.enrollmentDeviceId !== null && !uuid(expected.enrollmentDeviceId)
      || !['source_connected', 'knowledge_only'].includes(input.mode)) return blocked('guided_route_context_invalid');
    if (Buffer.byteLength(JSON.stringify(input.context) ?? '') > 65536) return blocked('guided_route_context_invalid');
    const validation = await validateContract(fileURLToPath(new URL('./schemas', import.meta.url)),
      'https://schemas.dharma-ai.io/guided-route-context/v1', input.context);
    if (!validation.ok) return blocked('guided_route_context_invalid');
    const context = input.context as Context, { signature, ...body } = context;
    const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: expected.publicKeyEd25519 } });
    if (Buffer.from(signature, 'base64url').toString('base64url') !== signature || !verifyCanonicalObject(body, signature, key)
      || context.organizationId !== expected.organizationId || context.recipientMembershipId !== expected.recipientMembershipId
      || context.hqOrigin !== expected.hqOrigin || context.roleRevision !== expected.roleRevision
      || context.policyRevision !== expected.policyRevision || context.sessionId !== expected.sessionId
      || context.deviceId !== expected.enrollmentDeviceId || context.provider !== expected.provider
      || Date.parse(context.issuedAt) > now.getTime() || Date.parse(context.expiresAt) <= now.getTime()
      || Date.parse(context.expiresAt) - Date.parse(context.issuedAt) > 300000
      || Date.parse(context.expiresAt) <= Date.parse(context.issuedAt)
      || !context.allowedModes.includes(input.mode) || new Set(context.bindings.map(b => b.id)).size !== context.bindings.length) {
      return blocked('guided_route_context_mismatch');
    }
    if (input.mode === 'knowledge_only' && !expected.enrollmentDeviceId) return blocked('guided_route_enrollment_required');
    const binding = context.bindings.find(b => b.id === expected.bindingId);
    if (!binding || binding.sourceFingerprint !== expected.sourceFingerprint || binding.manifestHash !== expected.manifestHash
      || binding.catalogHash !== expected.catalogHash) return blocked('guided_route_binding_unavailable');
    return { ...blocked('guided_route_plan'), ok: true, stage: 'plan' as const, organizationId: context.organizationId,
      bindingId: binding.id, roleRevision: context.roleRevision, contextHash: sha256(canonicalize(context)), expiresAt: context.expiresAt,
      nextAction: input.mode === 'knowledge_only' ? 'existing_enrolled_knowledge_join' : 'existing_source_connected_setup',
      requiresSourceCheckout: input.mode === 'source_connected', initializesEmptyGit: input.mode === 'knowledge_only' };
  } catch {
    return blocked('guided_route_context_invalid');
  }
}
