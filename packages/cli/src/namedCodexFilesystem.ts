import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

// Sandbox children need the installed public provider code, never its private home.
export async function namedCodexFilesystem(input: {
  environment: NodeJS.ProcessEnv; workspace: string; privateRoots: string[]; writeRoots: string[];
}): Promise<{ peer: string; work: string; runtimeRoots: string[] }> {
  const denied = input.privateRoots.map(root => resolve(root));
  const runtimeRoots: string[] = [];
  if (process.platform === 'linux') {
    let executable: string | undefined;
    for (const root of (input.environment.PATH || '').split(delimiter)) {
      if (!isAbsolute(root)) continue;
      const candidate = join(root, 'codex');
      try { await access(candidate, constants.X_OK); executable = await realpath(candidate); break; }
      catch { /* Continue through the existing provider PATH only. */ }
    }
    if (!executable) throw new Error('named_session_provider_runtime_missing');
    let directory = dirname(executable);
    for (let depth = 0; depth < 5; depth++) {
      let manifest: { name?: string; optionalDependencies?: Record<string, string> } | undefined;
      try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); }
      catch { /* A standalone native executable needs only its exact file. */ }
      if (manifest?.name === '@openai/codex') {
        runtimeRoots.push(directory);
        for (const name of Object.keys(manifest.optionalDependencies || {})) {
          if (name !== `@openai/codex-linux-${process.arch}`) continue;
          const native = join(dirname(directory), name.slice('@openai/'.length));
          try {
            const metadata = JSON.parse(await readFile(join(native, 'package.json'), 'utf8'));
            const alias = manifest.optionalDependencies![name];
            const aliased = typeof alias === 'string' && alias === `npm:@openai/codex@${metadata.version}`;
            if (!(metadata.name === name || metadata.name === '@openai/codex' && aliased)
              || !(await stat(native)).isDirectory()) throw new Error('named_session_provider_runtime_invalid');
            runtimeRoots.push(await realpath(native));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            // Older public distributions embed their vendor binary in the main package.
          }
        }
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    if (!runtimeRoots.length) runtimeRoots.push(executable);
  }
  for (const root of runtimeRoots) {
    if (contains(input.workspace, root) || denied.some(privateRoot => contains(root, privateRoot) || contains(privateRoot, root))) {
      throw new Error('named_session_provider_runtime_scope_invalid');
    }
  }
  const shared: Record<string, string> = { ':minimal': 'read' };
  for (const root of runtimeRoots) shared[root] = 'read';
  for (const root of denied) shared[root] = 'deny';
  const roots = { '.': 'read', ...Object.fromEntries(input.writeRoots.map(root => [root, 'write'])) };
  const table = (entries: Record<string, string>) => `{${Object.entries(entries)
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`;
  const profile = (workspaceRoots: Record<string, string>) => `{${Object.entries(shared)
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')},":workspace_roots"=${table(workspaceRoots)}}`;
  return { peer: profile({ '.': 'read' }), work: profile(roots), runtimeRoots };
}
