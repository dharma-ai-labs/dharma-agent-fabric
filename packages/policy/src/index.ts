import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parse } from 'yaml';

export interface CommandPolicy {
  argv: string[];
  timeoutSeconds: number;
  workingDirectory?: string;
}

export interface OrganizationPolicy {
  schema: 'dharma.organization-policy/v1';
  organizationId: string;
  revision: string;
  evidence: {
    defaultMode: 'structured' | 'deep' | 'reduced_full_session' | 'incident_capture';
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
}

export const MAXIMUM_TRAJECTORY_CAPSULE_BYTES = 1_048_576;

export async function loadOrganizationPolicy(path: string): Promise<OrganizationPolicy> {
  const policy = parse(await readFile(path, 'utf8')) as OrganizationPolicy;
  assertPolicy(policy);
  return policy;
}

export function assertPolicy(policy: OrganizationPolicy): void {
  if (policy.schema !== 'dharma.organization-policy/v1') throw new Error('Unsupported policy schema.');
  if (!policy.organizationId || !policy.revision) throw new Error('Policy identity is required.');
  if (policy.evidence.registeredWorkspaceOnly !== true) {
    throw new Error('registeredWorkspaceOnly must remain true.');
  }
  if (!Number.isInteger(policy.evidence.maximumCapsuleBytes)
    || policy.evidence.maximumCapsuleBytes < 1
    || policy.evidence.maximumCapsuleBytes > MAXIMUM_TRAJECTORY_CAPSULE_BYTES) {
    throw new Error(`maximumCapsuleBytes must be between 1 and ${MAXIMUM_TRAJECTORY_CAPSULE_BYTES}.`);
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
