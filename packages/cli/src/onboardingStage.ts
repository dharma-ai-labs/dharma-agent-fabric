export type OnboardingStage =
  | 'local_skill_inventory'
  | 'first_learning_preview'
  | 'first_learning_sync'
  | 'package_snapshot'
  | 'package_publication'
  | 'role_registration'
  | 'native_skill_install'
  | 'relay_start'
  | 'autostart'
  | 'readiness';

export async function withOnboardingStage<T>(
  stage: OnboardingStage,
  workspaceId: string,
  resumeCommand: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `agent_fabric_onboarding_${stage}: ${reason}\nworkspace_id: ${workspaceId}\nresume_command: ${resumeCommand}`,
      { cause: error },
    );
  }
}
