import { readFile } from 'node:fs/promises';

export type WorkspaceRegistryRead<T> = {
  state: 'absent' | 'valid';
  records: T[];
};

export async function readWorkspaceRegistry<T>(
  path: string,
  read: (path: string) => Promise<string> = (file) => readFile(file, 'utf8'),
): Promise<WorkspaceRegistryRead<T>> {
  let contents: string;
  try {
    contents = await read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'absent', records: [] };
    }
    throw new Error('workspace_registry_read_failed', { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error('workspace_registry_invalid', { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error('workspace_registry_invalid');
  return { state: 'valid', records: parsed as T[] };
}
