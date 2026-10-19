import { createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256, validateContract, verifyCanonicalObject } from '@dharma-ai-labs/agent-fabric-contracts';

type Host = { mcpOrigin: string; mcpPath: string; appId: string; appVersion: string; deploymentId: string; sourceSha: string;
  registrationRevision: string; schemaHash: string; adapterId: string; adapterVersion: string; selectedLinkId: string };
type Expected = { organizationId: string; membershipId: string; bindingId: string; policyRevision: string; rootIdentity: string;
  targetKind: string; targetId: string; host: Host; publicKeyEd25519: string };
type Provenance = Omit<Expected, 'publicKeyEd25519'> & { schema: string; recordId: string; membershipStatus: 'active';
  registeredSelectors: string[]; observedAt: string; expiresAt: string; signature: string };
const requiredSelectors = ['scopeMode', 'organizationAgentIds', 'endpointIds', 'trajectoryTarget'];

/** Offline adapter contract only. Expected identity/host/pin must be obtained
 * independently through a supported authenticated readback. A plan is not an
 * analysis request, paid reservation, effective permission or live tuple proof. */
export async function planRootAnalysisScope(input: { provenance: unknown; expected: Expected; now?: Date }) {
  const denied = (code: string) => ({ ok: false, code, scope: null as null | {
    mode: 'agents' | 'endpoints'; organizationAgentIds: string[]; endpointIds: string[] },
    effects: false as const, analysisInvoked: false as const, requestAdmitted: false as const,
    authorityVerified: false as const, provenanceHash: null as string | null });
  try {
    const now = input.now ?? new Date(), expected = input.expected;
    if (!Number.isFinite(now.getTime()) || !/^[A-Za-z0-9_-]{43}$/.test(expected.publicKeyEd25519)
      || !['agent', 'endpoint'].includes(expected.targetKind) || !expected.host
      || Buffer.byteLength(JSON.stringify(input.provenance) ?? '') > 65536) return denied('root_analysis_provenance_invalid');
    const validation = await validateContract(fileURLToPath(new URL('./schemas', import.meta.url)),
      'https://schemas.dharma-ai.io/root-analysis-provenance/v1', input.provenance);
    if (!validation.ok) return denied('root_analysis_provenance_invalid');
    const provenance = input.provenance as Provenance, { signature, ...body } = provenance;
    const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: expected.publicKeyEd25519 } });
    const origin = new URL(provenance.host.mcpOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== provenance.host.mcpOrigin || origin.username || origin.password
      || Buffer.from(signature, 'base64url').toString('base64url') !== signature || !verifyCanonicalObject(body, signature, key)
      || ['organizationId', 'membershipId', 'bindingId', 'policyRevision', 'rootIdentity', 'targetKind', 'targetId']
        .some(k => provenance[k as keyof Provenance] !== expected[k as keyof Expected])
      || canonicalize(provenance.host) !== canonicalize(expected.host)
      || Date.parse(provenance.observedAt) > now.getTime() || Date.parse(provenance.expiresAt) <= now.getTime()
      || Date.parse(provenance.expiresAt) <= Date.parse(provenance.observedAt)
      || Date.parse(provenance.expiresAt) - Date.parse(provenance.observedAt) > 300000) {
      return denied('root_analysis_provenance_mismatch');
    }
    if (requiredSelectors.some(k => !provenance.registeredSelectors.includes(k))) {
      return denied('root_analysis_selector_contract_unavailable');
    }
    return { ...denied('root_analysis_scope_plan'), ok: true, provenanceHash: sha256(canonicalize(provenance)),
      scope: provenance.targetKind === 'agent'
        ? { mode: 'agents' as const, organizationAgentIds: [provenance.targetId], endpointIds: [] }
        : { mode: 'endpoints' as const, organizationAgentIds: [], endpointIds: [provenance.targetId] } };
  } catch {
    return denied('root_analysis_provenance_invalid');
  }
}
