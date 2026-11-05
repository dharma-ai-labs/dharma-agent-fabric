import { existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

// npm's cmd-shim ends with `"%dp0%\<target>" %*`. Node refuses to spawn a .cmd
// without a shell, and a shell would reparse task arguments.
const SHIM_TARGET = /"%dp0%\\([^"\r\n]+\.(?:c?js|mjs|exe))"\s+%\*/;

/** Starts a Windows CLI installed only as an npm shim through the shim's own target, never a shell. */
export function providerLaunch(command: string, argv: string[], environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform): { command: string; argv: string[] } {
  const unchanged = { command, argv };
  if (platform !== 'win32' || /[\\/.]/.test(command)) return unchanged;
  // Only absolute PATH entries: a repository must not supply its own provider shim.
  const roots = (environment.PATH ?? environment.Path ?? '').split(delimiter).filter(root => isAbsolute(root));
  if (roots.some(root => existsSync(join(root, `${command}.exe`)) || existsSync(join(root, `${command}.com`)))) return unchanged;
  const root = roots.find(entry => existsSync(join(entry, `${command}.cmd`)));
  if (!root) return unchanged;
  const relativeTarget = SHIM_TARGET.exec(readFileSync(join(root, `${command}.cmd`), 'utf8'))?.[1];
  if (!relativeTarget) return unchanged;
  const target = join(root, ...relativeTarget.split('\\'));
  if (!existsSync(target)) return unchanged;
  return target.endsWith('.exe') ? { command: target, argv } : { command: process.execPath, argv: [target, ...argv] };
}
