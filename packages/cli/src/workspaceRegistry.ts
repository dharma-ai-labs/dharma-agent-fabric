import { readFile } from 'node:fs/promises';
import {currentBootstrapHostScope} from './bootstrapHostScope.js';

export type WorkspaceRegistryRead<T> = {
  state: 'absent' | 'valid';
  records: T[];
};

export async function readWorkspaceRegistry<T>(
  path: string,
  read: (path: string) => Promise<string> = (file) => readFile(file, 'utf8'),
): Promise<WorkspaceRegistryRead<T>> {
  const scope = currentBootstrapHostScope();
  let contents: string;
  try {
    contents = await (scope ? scope.step(() => read(path)) : read(path));
  } catch (error) {
    await scope?.assert();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'absent', records: [] };
    }
    throw new Error('workspace_registry_read_failed', scope ? undefined : { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error('workspace_registry_invalid', scope ? undefined : { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error('workspace_registry_invalid');
  await scope?.assert();
  return { state: 'valid', records: parsed as T[] };
}
