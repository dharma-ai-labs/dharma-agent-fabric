import { fileURLToPath } from 'node:url';
import { resolveRegisteredCommand, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { acceptanceCommandEnvironmentPolicy } from '@dharma-ai-labs/agent-fabric-task-runner';

/** The launcher that starts a skill smoke check with the explicit command environment. */
export const smokeCommandLauncherPath = fileURLToPath(new URL('./smokeCommandLauncher.js', import.meta.url));

type CommandPolicies = { tasks: { allowedCommands: Record<string, { argv: string[]; timeoutSeconds: number }> } };

/**
 * Returns a copy of `policy` in which the registered smoke command runs through the smoke
 * launcher. The launcher gives the command operating-system essentials and the names its
 * policy entry lists under `environment.inherit`, then runs the original argv unchanged.
 * Only variable names go on the launcher's argv, never values. The command id and timeout
 * stay the same, so the receipt check name and the pass, fail and rollback flow do not change.
 */
export function smokeCommandPolicy<T extends CommandPolicies>(policy: T, commandId: string,
  launch: { execPath: string; launcher: string } = { execPath: process.execPath, launcher: smokeCommandLauncherPath }): T {
  const command = resolveRegisteredCommand(policy as unknown as OrganizationPolicy, commandId);
  const environment = acceptanceCommandEnvironmentPolicy(command, commandId);
  const argv = [launch.execPath, launch.launcher, '--timeout-ms', String(command.timeoutSeconds * 1_000),
    ...(environment?.inherit ?? []).flatMap(name => ['--inherit', name]), '--', ...command.argv];
  const commands = policy.tasks.allowedCommands;
  return {
    ...policy,
    tasks: { ...policy.tasks, allowedCommands: { ...commands, [commandId]: { ...commands[commandId]!, argv } } },
  };
}
