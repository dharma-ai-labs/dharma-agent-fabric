import {randomUUID} from 'node:crypto';
import {link, lstat, mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {HostOperationFence} from './hostOperationScope.js';

export interface EnrollmentAnchorLockRelease {
  (): Promise<void>;
  assertHeld(): Promise<void>;
}

// Adapted from the CLI PID-lock publication pattern. Fully initialized owner
// files are published by hard link, never by an overwriting rename.
// A recovery mutex serializes dead-primary cleanup; an abandoned recovery mutex
// is preserved for explicit recovery. Automatically reclaiming that mutex would
// introduce another check-then-replace race.
// Owner contents are flushed before publication, so a live owner's file always
// holds its PID. Contents that cannot be a PID have no owner and count as dead,
// so they are quarantined under the mutex like any dead owner (#417), including
// the empty or NUL lock a host crash can leave (#484).
// That candidate flush happens once, before the mutex: a flush under the mutex could commit
// the mutex link without its later unlink, and a hard reset would then leave an
// abandoned mutex. Nothing is flushed while the mutex exists: only link, unlink,
// rename, lstat, readFile and process.kill run under it. For the same reason a
// waiter keeps the mutex untouched while the lock has a live owner: every mutex
// that exists is one a hard reset can leave behind. A failed flush, of the
// candidate or of the lock folder, is connection_anchor_lock_flush_failed, and an
// unflushed candidate is never published.
//
// Folder flush after publication, per OS. None of this is a crash-safety claim:
// it narrows the window in which a published link can be lost, nothing more.
// - Linux: fsync on the folder commits the new directory entry (ext4, xfs, btrfs).
// - macOS: fsync on the folder is accepted, but without F_FULLFSYNC the drive may
//   still hold the entry in its cache.
// - Windows: Node cannot open a folder handle to flush, so nothing is flushed;
//   NTFS records the metadata change in its own journal.
// The folder is flushed only after the recovery mutex is gone, for the reason above.
export async function acquireEnrollmentAnchorLock(
  lockPath: string, scope?: HostOperationFence, timeoutMs = 10_000,
): Promise<EnrollmentAnchorLockRelease> {
  const step = <T>(operation: () => Promise<T>) => scope ? scope.step(operation) : operation();
  type Owned = {dev: bigint; ino: bigint};
  const owned = new Map<string, Owned | null>();
  const directory = dirname(lockPath);
  let namespace: Owned | undefined;
  const assertNamespace = async () => {
    if (process.platform === 'win32') return;
    const value = await lstat(directory, {bigint: true});
    if (!value.isDirectory() || value.isSymbolicLink() || typeof process.getuid !== 'function'
      || value.uid !== BigInt(process.getuid()) || (value.mode & 0o077n) !== 0n
      || namespace && (value.dev !== namespace.dev || value.ino !== namespace.ino)) {
      throw Error('connection_anchor_lock_invalid');
    }
    namespace ??= {dev: value.dev, ino: value.ino};
  };
  const metadata = async (path: string): Promise<Owned> => {
    const value = await lstat(path, {bigint: true});
    if (!value.isFile() || value.isSymbolicLink()) throw Error('connection_anchor_lock_invalid');
    return {dev: value.dev, ino: value.ino};
  };
  const cleanup = async (path: string) => {
    if (!owned.has(path)) return;
    try {
      await assertNamespace();
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
  const prepare = async () => {
    const candidate = `${lockPath}.${process.pid}.${randomUUID()}.candidate`;
    await step(async () => {
      await assertNamespace();
      const file = await open(candidate, 'wx', 0o600);
      try {
        // Owned before any byte is written, so a failed write or flush removes it.
        owned.set(candidate, null);
        owned.set(candidate, await metadata(candidate));
        await file.writeFile(`${process.pid}\n`);
        try {await file.sync();} catch (cause) {throw Error('connection_anchor_lock_flush_failed', {cause});}
      } finally {await file.close();}
    });
    return candidate;
  };
  const publish = (candidate: string, path: string) => step(async () => {
    await assertNamespace();
    await link(candidate, path);
    owned.set(path, owned.get(candidate)!);
  });
  const owner = async (path: string) => {
    let identity: Owned, text: string;
    try {
      identity = await step(() => metadata(path));
      text = (await step(() => readFile(path, 'utf8'))).trim();
    } catch (error) {
      // Unreadable Windows ownership is unknown, not absent. The caller waits
      // under its existing deadline/fence without reclaiming this owner.
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return null;
      throw error;
    }
    // process.kill refuses anything above this range, so no such owner can be checked.
    if (!/^[1-9][0-9]*$/.test(text) || Number(text) > 0x7fffffff) return {identity, alive: false};
    let alive = true;
    try {await step(async () => {process.kill(Number(text), 0);});}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      alive = false;
    }
    return {identity, alive};
  };
  // undefined means the path is absent. null still means ownership is unknown.
  const inspect = async (path: string) => {
    try {return await owner(path);}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    }
  };
  const pause = () => step(() => new Promise<void>(accept => setTimeout(accept, 25)));
  const flushFolder = () => step(async () => {
    if (process.platform === 'win32') return;
    try {
      const folder = await open(directory, 'r');
      try {await folder.sync();} finally {await folder.close();}
    } catch (cause) {throw Error('connection_anchor_lock_flush_failed', {cause});}
  });
  try {
    await step(() => mkdir(directory, {recursive: true, mode: 0o700}));
    await step(assertNamespace);
    const candidate = await prepare();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() >= deadline) throw Error('connection_anchor_busy');
      // This read-only check can only decide to wait. It changes nothing, so a
      // stale answer costs one more retry, and the owner is inspected again under
      // the mutex before anything is published or quarantined.
      const holder = await inspect(lockPath);
      if (holder === null || holder?.alive) {await pause(); continue;}
      // Every primary publication participates in this mutex. An exiting owner
      // may release its primary during inspection, but no replacement can publish
      // until the inspector releases the mutex.
      const recovery = lockPath + '.recovery';
      let recovering = false;
      try {await publish(candidate, recovery); recovering = true;}
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const current = await inspect(recovery);
        if (current && !current.alive) throw Error('connection_anchor_recovery_required');
      }
      if (recovering) {
        let published = false;
        try {
          try {
            await publish(candidate, lockPath);
            await cleanup(candidate);
            published = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          const current = published ? undefined : await inspect(lockPath);
          if (current && !current.alive) {
            const quarantine = `${lockPath}.dead.${randomUUID()}`;
            try {
              await step(async () => {
                await rename(lockPath, quarantine);
                owned.set(quarantine, current.identity);
              });
              await cleanup(quarantine);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        } finally {await cleanup(recovery);}
        if (published) {
          await flushFolder();
          let released: Promise<void> | undefined;
          return Object.assign(() => released ??= cleanup(lockPath), {assertHeld: async () => {
            if (released) throw Error('connection_anchor_lock_invalid');
            await step(assertNamespace);
            const expected = owned.get(lockPath), actual = await step(() => metadata(lockPath));
            if (!expected || actual.dev !== expected.dev || actual.ino !== expected.ino) throw Error('connection_anchor_lock_invalid');
          }});
        }
      }
      await pause();
    }
  } catch (error) {
    let failed = false;
    for (const path of owned.keys()) try {await cleanup(path);} catch {failed = true;}
    if (failed) throw Error('connection_anchor_lock_cleanup_unconfirmed');
    if (!scope) throw error;
    await scope.assert();
    if (error instanceof Error && ['connection_anchor_busy', 'connection_anchor_recovery_required',
      'connection_anchor_lock_invalid', 'connection_anchor_lock_flush_failed'].includes(error.message)) throw error;
    throw Error('connection_anchor_lock_unavailable');
  }
}
