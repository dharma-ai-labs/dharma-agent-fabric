import type { TaskEnvelope } from '@dharma-ai-labs/agent-fabric-task-runner';

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function studyTaskIdFromFlags(
  flags: Map<string, string | boolean>, workspaceId: string,
): string | undefined {
  if (!flags.has('study-task-id')) return undefined;
  const taskId = flags.get('study-task-id');
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)
    || flags.get('workspace-id') !== workspaceId) {
    throw new Error('Study exact task selection requires a UUID and explicit registered workspace.');
  }
  return taskId;
}

export function assertStudyExactPoll(
  polled: Record<string, unknown>, taskId: string, workspaceId: string,
): void {
  if (polled.selectedStudyTaskId !== taskId) {
    throw new Error('Server did not acknowledge exact study task selection.');
  }
  const taskRow = polled.task;
  if (taskRow === null || taskRow === undefined) return;
  if (!taskRow || typeof taskRow !== 'object' || Array.isArray(taskRow)) {
    throw new Error('Exact study task poll returned an invalid task row.');
  }
  const envelope = (taskRow as { envelope?: TaskEnvelope }).envelope;
  if (!envelope || envelope.taskId !== taskId || envelope.workspaceId !== workspaceId) {
    throw new Error('Exact study task poll returned another task or workspace.');
  }
}
