import {mkdir, open, rename, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, isAbsolute, resolve} from 'node:path';
import type {BootstrapHostScope} from './bootstrapHostScope.js';

/** Lifetime fence, not a replacement for the caller's approved path policy. */
export async function writeBootstrapHostJson(path: string, value: unknown, scope: BootstrapHostScope) {
  await scope.assert();
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('codex_setup_host_state_path_invalid');
  let bytes: string;
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) throw new Error();
    bytes = `${serialized}\n`;
  } catch {await scope.assert(); throw new Error('codex_setup_host_state_invalid');}
  await scope.assert();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await scope.step(() => mkdir(dirname(path), {recursive: true, mode: 0o700}));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let owned = false;
  try {
    await scope.assert(); handle = await open(temporary, 'wx', 0o600); owned = true; await scope.assert();
    await scope.step(() => handle!.writeFile(bytes));
    await scope.step(() => handle!.sync());
    await handle.close(); handle = undefined;
    await scope.step(() => rename(temporary, path));
  } finally {
    await handle?.close();
    // Only our successfully created temporary is cleanup-authorized. Never
    // remove or roll back the destination if publication already happened.
    if (owned) await rm(temporary, {force: true});
  }
}
