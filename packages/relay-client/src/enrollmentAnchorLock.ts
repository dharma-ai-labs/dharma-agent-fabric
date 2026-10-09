import {randomUUID} from 'node:crypto';
import {link, lstat, mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {HostOperationFence} from './hostOperationScope.js';

// Adapted from the CLI PID-lock publication pattern. Fully initialized owner
// files are published by hard link, never by an overwriting rename.
// A recovery mutex serializes dead-primary cleanup; an abandoned recovery mutex
// is preserved for explicit recovery. Automatically reclaiming that mutex would
// introduce another check-then-replace race.
export async function acquireEnrollmentAnchorLock(
  lockPath: string, scope?: HostOperationFence, timeoutMs = 10_000,
): Promise<() => Promise<void>> {
  const step = <T>(operation: () => Promise<T>) => scope ? scope.step(operation) : operation();
  type Owned = {dev: bigint; ino: bigint};
  const owned = new Map<string, Owned | null>();
  const metadata = async (path: string): Promise<Owned> => {
    const value = await lstat(path, {bigint: true});
    if (!value.isFile() || value.isSymbolicLink()) throw Error('connection_anchor_lock_invalid');
    return {dev: value.dev, ino: value.ino};
  };
  const cleanup = async (path: string) => {
    if (!owned.has(path)) return;
    try {
      const expected = owned.get(path);
      if (!expected) throw Error();
      let current: Owned;
      try {current = await metadata(path);}
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        owned.delete(path); return;
      }
      if (current.dev !== expected.dev || current.ino !== expected.ino) throw Error();
      await unlink(path);
      owned.delete(path);
    } catch {throw Error('connection_anchor_lock_cleanup_unconfirmed');}
  };
  const publish = async (path: string) => {
    const candidate = `${path}.${process.pid}.${randomUUID()}.candidate`;
    try {
      await step(async () => {
        await writeFile(candidate, `${process.pid}\n`, {flag: 'wx', mode: 0o600});
        owned.set(candidate, null);
        owned.set(candidate, await metadata(candidate));
      });
      await step(async () => {
        await link(candidate, path);
        owned.set(path, owned.get(candidate)!);
      });
    } finally {await cleanup(candidate);}
  };
  const owner = async (path: string) => {
    const identity = await step(() => metadata(path));
    const text = (await step(() => readFile(path, 'utf8'))).trim();
    if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) {
      throw Error('connection_anchor_lock_invalid');
    }
    let alive = true;
    try {await step(async () => {process.kill(Number(text), 0);});}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      alive = false;
    }
    return {identity, alive};
  };
  try {
    await step(() => mkdir(dirname(lockPath), {recursive: true, mode: 0o700}));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() >= deadline) throw Error('connection_anchor_busy');
      // Every primary publication participates in this mutex. An exiting owner
      // may release its primary during inspection, but no replacement can publish
      // until the inspector releases the mutex.
      const recovery = lockPath + '.recovery';
      let recovering = false;
      try {await publish(recovery); recovering = true;}
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (!(await owner(recovery)).alive) throw Error('connection_anchor_recovery_required');
        } catch (inspection) {
          if ((inspection as NodeJS.ErrnoException).code !== 'ENOENT') throw inspection;
        }
      }
      if (recovering) {
        try {
          try {
            await publish(lockPath);
            let released: Promise<void> | undefined;
            return () => released ??= cleanup(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          let current: Awaited<ReturnType<typeof owner>> | undefined;
          try {current = await owner(lockPath);}
          catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
          if (current && !current.alive) {
            const quarantine = `${lockPath}.dead.${randomUUID()}`;
            try {
              await step(async () => {
                await rename(lockPath, quarantine);
                owned.set(quarantine, current!.identity);
              });
              await cleanup(quarantine);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        } finally {await cleanup(recovery);}
      }
      await step(() => new Promise<void>(accept => setTimeout(accept, 25)));
    }
  } catch (error) {
    let failed = false;
    for (const path of owned.keys()) try {await cleanup(path);} catch {failed = true;}
    if (failed) throw Error('connection_anchor_lock_cleanup_unconfirmed');
    if (!scope) throw error;
    await scope.assert();
    if (error instanceof Error && ['connection_anchor_busy', 'connection_anchor_recovery_required',
      'connection_anchor_lock_invalid'].includes(error.message)) throw error;
    throw Error('connection_anchor_lock_unavailable');
  }
}
