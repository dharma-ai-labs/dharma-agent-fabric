import { readFile } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { parse } from 'yaml';

export interface CommandPolicy {
  argv: string[];
  timeoutSeconds: number;
  workingDirectory?: string;
}

export interface OrganizationPolicy {
  schema: 'dharma.organization-policy/v1' | 'dharma.organization-policy/v2';
  organizationId: string;
  revision: string;
  evidence: {
    defaultMode: 'structured' | 'deep' | 'reduced_full_session' | 'incident_capture';
    automaticDisclosure?: {
      mode: 'metadata_only' | 'local_analysis' | 'customer_authorized_content';
      consentReceiptId?: string;
      allowedContentClasses?: Array<'native_provider_payload'>;
    };
    registeredWorkspaceOnly: true;
    excludePaths: string[];
    maximumCapsuleBytes: number;
    maximumDailyUploadBytes: number;
    maximumExpansionBytes: number;
    pseudonymizeIdentity?: boolean;
  };
  tasks: {
    defaultNetwork: 'deny' | 'package_registry_only' | 'allowlisted_domains' | 'inherit_local_provider';
    defaultGit: 'read_only' | 'task_branch' | 'merge_allowed' | 'deploy_allowed';
    allowedCommands: Record<string, CommandPolicy>;
    writePaths: string[];
    requireLocalConfirmationFor: string[];
  };
  skills: {
    automaticInstall: boolean;
    automaticPromotionMaxRisk: 'R0' | 'R1' | 'R2' | 'R3' | 'R4';
    canaryPercent: number;
  };
  retention: Record<string, unknown>;
  budgets: Record<string, unknown>;
  serverAuthorization?: {
    schema: 'dharma.workspace-policy-authorization/v1';
    organizationId: string;
    workspaceId: string;
    policy: {
      revision: string;
      evidence: {
        automaticDisclosure: {
          mode: 'metadata_only' | 'local_analysis' | 'customer_authorized_content';
          consentReceiptId?: string;
          allowedContentClasses?: Array<'native_provider_payload'>;
        };
        maximumCapsuleBytes: number;
        maximumDailyUploadBytes: number;
        maximumExpansionBytes: number;
        excludePaths: string[];
        pseudonymizeIdentity: true;
      };
    };
    issuedAt: string;
    expiresAt: string;
    signature: string;
    keyVersion: string;
  };
}

export const MAXIMUM_TRAJECTORY_CAPSULE_BYTES = 1_048_576;
const verifiedContentPolicies = new WeakSet<object>();

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

export function verifyServerAuthorizedPolicy(input: {
  policy: OrganizationPolicy;
  publicKeyEd25519: string;
  organizationId: string;
  workspaceId: string;
  now?: Date;
}): OrganizationPolicy {
  const authorization = input.policy.serverAuthorization;
  if (!authorization) throw new Error('Server workspace policy authorization is required.');
  const now = input.now || new Date();
  const issuedAt = Date.parse(authorization.issuedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  if (authorization.organizationId !== input.organizationId
    || authorization.workspaceId !== input.workspaceId
    || !Number.isFinite(issuedAt) || issuedAt > now.getTime() + 5 * 60_000
    || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new Error('Server workspace policy authorization is invalid or expired.');
  }
  const { signature, keyVersion: _keyVersion, ...unsigned } = authorization;
  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: input.publicKeyEd25519 },
    format: 'jwk',
  });
  const valid = verify(
    null,
    Buffer.from(JSON.stringify(canonicalValue(unsigned)), 'utf8'),
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
  if (!valid) throw new Error('Server workspace policy authorization signature is invalid.');
  const signedEvidence = authorization.policy.evidence;
  if (authorization.policy.revision !== input.policy.revision
    || JSON.stringify(canonicalValue(signedEvidence.automaticDisclosure)) !== JSON.stringify(canonicalValue(input.policy.evidence.automaticDisclosure))
    || signedEvidence.maximumCapsuleBytes !== input.policy.evidence.maximumCapsuleBytes
    || signedEvidence.maximumDailyUploadBytes !== input.policy.evidence.maximumDailyUploadBytes
    || signedEvidence.maximumExpansionBytes !== input.policy.evidence.maximumExpansionBytes
    || JSON.stringify(canonicalValue(signedEvidence.excludePaths)) !== JSON.stringify(canonicalValue(input.policy.evidence.excludePaths))
    || signedEvidence.pseudonymizeIdentity !== true
    || input.policy.evidence.pseudonymizeIdentity !== true) {
    throw new Error('Local evidence policy does not match its signed server authorization.');
  }
  verifiedContentPolicies.add(input.policy);
  return input.policy;
}

export async function loadOrganizationPolicy(path: string): Promise<OrganizationPolicy> {
  const policy = parse(await readFile(path, 'utf8')) as OrganizationPolicy;
  assertPolicy(policy, { allowUnverifiedAuthorization: true });
  return policy;
}

export function assertPolicy(policy: OrganizationPolicy, options: { allowUnverifiedAuthorization?: boolean } = {}): void {
  if (policy.schema !== 'dharma.organization-policy/v1' && policy.schema !== 'dharma.organization-policy/v2') {
    throw new Error('Unsupported policy schema.');
  }
  if (!policy.organizationId || !policy.revision) throw new Error('Policy identity is required.');
  if (policy.evidence.registeredWorkspaceOnly !== true) {
    throw new Error('registeredWorkspaceOnly must remain true.');
  }
  if (!Number.isInteger(policy.evidence.maximumCapsuleBytes)
    || policy.evidence.maximumCapsuleBytes < 1
    || policy.evidence.maximumCapsuleBytes > MAXIMUM_TRAJECTORY_CAPSULE_BYTES) {
    throw new Error(`maximumCapsuleBytes must be between 1 and ${MAXIMUM_TRAJECTORY_CAPSULE_BYTES}.`);
  }
  const disclosure = policy.evidence.automaticDisclosure;
  if (policy.schema === 'dharma.organization-policy/v1' && disclosure !== undefined) {
    throw new Error('automaticDisclosure requires organization policy v2.');
  }
  if (disclosure?.mode === 'customer_authorized_content') {
    if (policy.schema !== 'dharma.organization-policy/v2') {
      throw new Error('customer_authorized_content requires organization policy v2.');
    }
    if (!disclosure.consentReceiptId?.trim()) {
      throw new Error('customer_authorized_content requires a consentReceiptId.');
    }
    if (!disclosure.allowedContentClasses?.includes('native_provider_payload')) {
      throw new Error('customer_authorized_content requires an explicit native_provider_payload content grant.');
    }
    if (policy.serverAuthorization?.schema !== 'dharma.workspace-policy-authorization/v1') {
      throw new Error('customer_authorized_content requires a server-signed workspace authorization.');
    }
    if (!options.allowUnverifiedAuthorization && !verifiedContentPolicies.has(policy)) {
      throw new Error('customer_authorized_content requires cryptographic server authorization verification.');
    }
  } else if (disclosure?.consentReceiptId || disclosure?.allowedContentClasses?.length) {
    throw new Error('Content grants are only valid for customer_authorized_content.');
  }
  if (policy.skills.automaticPromotionMaxRisk === 'R3' || policy.skills.automaticPromotionMaxRisk === 'R4') {
    throw new Error('Automatic promotion cannot grant R3 or R4 authority.');
  }
}

export function resolveRegisteredCommand(
  policy: OrganizationPolicy,
  commandId: string,
): CommandPolicy {
  const command = policy.tasks.allowedCommands[commandId];
  if (!command || command.argv.length === 0) throw new Error(`Command is not registered: ${commandId}`);
  if (command.argv.some((part) => part.includes('\0') || part.includes('\n') || part.includes('\r'))) {
    throw new Error(`Registered command contains an invalid argument: ${commandId}`);
  }
  return structuredClone(command);
}

export function assertPathWithinWorkspace(workspace: string, candidate: string): string {
  const root = resolve(workspace);
  const absolute = resolve(root, candidate);
  const route = relative(root, absolute);
  if (route === '..' || route.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(route)) {
    throw new Error('Path escapes the registered workspace.');
  }
  return absolute;
}
