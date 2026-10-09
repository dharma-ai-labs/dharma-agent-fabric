import {randomUUID} from 'node:crypto';
import {link, lstat, mkdir, readFile, rename, rm, unlink, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import type {HostOperationFence} from './hostOperationScope.js';

// Publish the fully initialized owner via an atomic hard link. Only a dead PID
// permits recovery; permission errors and malformed metadata remain failures.
// The recovery directory serializes stale-owner cleanup across processes.
// Cleanup verifies the inode captured at acquisition, even after scope withdrawal.
export async function acquireEnrollmentAnchorLock(lockPath: string, scope?: HostOperationFence, timeoutMs = 10_000): Promise<() => Promise<void>> {
  const timeoutMessage = "connection_anchor_busy";
  const step = <T>(operation: () => Promise<T>): Promise<T> => scope ? scope.step(operation) : operation();
  type OwnedPath = {dev: bigint; ino: bigint; directory: boolean};
  const owned = new Map<string, OwnedPath | null>();
  const recordOwned = async (path: string) => {
    owned.set(path, null);
    // Metadata for cooperative cleanup is captured even if creation withdrew authority.
    const metadata = await lstat(path, {bigint: true});
    if (metadata.isSymbolicLink() || !metadata.isFile() && !metadata.isDirectory()) {
      throw new Error('connection_anchor_lock_cleanup_unconfirmed');
    }
    owned.set(path, {dev: metadata.dev, ino: metadata.ino, directory: metadata.isDirectory()});
  };
  const cleanupOwned = async (path: string, directory = false) => {
    if (!owned.has(path)) return;
    try {
      const expected = owned.get(path);
      if (!expected) throw new Error();
      const metadata = await lstat(path, {bigint: true}).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;
      });
      if (metadata) {
        if (metadata.isSymbolicLink() || metadata.dev !== expected.dev || metadata.ino !== expected.ino
          || metadata.isDirectory() !== expected.directory || !expected.directory && !metadata.isFile()) throw new Error();
        if (expected.directory) await rm(path, {recursive: true, force: true});
        else await unlink(path);
      }
      owned.delete(path);
    } catch {throw new Error('connection_anchor_lock_cleanup_unconfirmed');}
  };
  try {
    await step(() => mkdir(dirname(lockPath), { recursive: true, mode: 0o700 }));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const candidate = `${lockPath}.${process.pid}.${randomUUID()}.candidate`;
      try {
        await step(async () => {
          await writeFile(candidate, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
          await recordOwned(candidate);
        });
        await step(async () => {
          await link(candidate, lockPath);
          owned.set(lockPath, owned.get(candidate)!);
        });
        await step(() => cleanupOwned(candidate));
      let release: Promise<void> | undefined;
      return () => release ??= cleanupOwned(lockPath);
      } catch (error) {
        await cleanupOwned(candidate);
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const recoveryPath = `${lockPath}.recovery`;
        const recoveryCandidate = `${recoveryPath}.${process.pid}.${randomUUID()}.candidate`;
        let windowsRecoveryOwner: number | undefined;
        try {
          await step(async () => {await mkdir(recoveryCandidate); await recordOwned(recoveryCandidate);});
          await step(() => writeFile(resolve(recoveryCandidate, 'owner'), `${process.pid}\n`, { mode: 0o600 }));
          for (;;) {
            try {
              await step(async () => {
                await rename(recoveryCandidate, recoveryPath);
                owned.set(recoveryPath, owned.get(recoveryCandidate)!); owned.delete(recoveryCandidate);
              });
              break;
            }
            catch (renameError) {
              if (process.platform !== 'win32' || (renameError as NodeJS.ErrnoException).code !== 'EPERM') throw renameError;
              // Windows uses EPERM for an existing destination. Its owner can
              // finish during inspection; retry publication, never ignore denial.
              try {
                const directory = await step(() => lstat(recoveryPath));
                const ownerPath = resolve(recoveryPath, 'owner');
                const ownerFile = await step(() => lstat(ownerPath));
                const ownerText = (await step(() => readFile(ownerPath, 'utf8'))).trim();
                const owner = Number(ownerText);
                if (!directory.isDirectory() || directory.isSymbolicLink()
                  || !ownerFile.isFile() || ownerFile.isSymbolicLink()
                  || !/^[1-9][0-9]*$/.test(ownerText) || !Number.isSafeInteger(owner)) throw renameError;
                windowsRecoveryOwner = owner;
              } catch (inspectionError) {
                let disappeared = (inspectionError as NodeJS.ErrnoException).code === 'ENOENT';
                // Invalid owner metadata rethrows renameError and remains an immediate denial.
                if (!disappeared && inspectionError !== renameError
                  && (inspectionError as NodeJS.ErrnoException).code === 'EPERM') {
                  // Windows can deny owner reads while its directory is being
                  // deleted. Observe only; never republish until absence is verified.
                  while (Date.now() < deadline) {
                    try { await step(() => lstat(recoveryPath)); }
                    catch (readbackError) {
                      if ((readbackError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
                      disappeared = true; break;
                    }
                    await step(() => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25)));
                  }
                }
                if (disappeared && Date.now() < deadline) {
                  await step(() => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25)));
                  continue;
                }
                throw renameError;
              }
              throw renameError;
            }
          }
          try {
            let ownerPid = 0;
            try {
              const metadata = await step(() => lstat(lockPath));
              const text = (await step(() => readFile(lockPath, 'utf8'))).trim();
              if (!metadata.isFile() || metadata.isSymbolicLink() || !/^[1-9][0-9]*$/.test(text)) {
                throw new Error('connection_anchor_lock_invalid');
              }
              ownerPid = Number(text);
            }
            catch (readError) {
              if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
              throw readError;
            }
            if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error("connection_anchor_lock_invalid");
            let ownerAlive = true;
            if (ownerAlive) {
              try { await step(async () => {process.kill(ownerPid, 0);}); }
              catch (killError) { if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') throw killError; ownerAlive = false; }
            }
            if (!ownerAlive) {
              const quarantine = `${lockPath}.dead.${randomUUID()}`;
              try {
                await step(() => rename(lockPath, quarantine));
                await step(() => unlink(quarantine));
                continue;
              } catch (renameError) {
                if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
              }
            }
          } finally {
            await cleanupOwned(recoveryPath, true);
          }
        } catch (recoveryError) {
          await cleanupOwned(recoveryCandidate, true);
          const recoveryCode = (recoveryError as NodeJS.ErrnoException).code || '';
          let recoveryOwner = 0;
          if (process.platform === 'win32' && recoveryCode === 'EPERM') {
            if (windowsRecoveryOwner === undefined) throw recoveryError;
            recoveryOwner = windowsRecoveryOwner;
          } else {
            if (!['EEXIST', 'ENOTEMPTY'].includes(recoveryCode)) throw recoveryError;
            const metadata = await step(() => lstat(recoveryPath));
            const ownerPath = resolve(recoveryPath, 'owner');
            const ownerMetadata = await step(() => lstat(ownerPath));
            const text = (await step(() => readFile(ownerPath, 'utf8'))).trim();
            if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownerMetadata.isFile()
              || ownerMetadata.isSymbolicLink() || !/^[1-9][0-9]*$/.test(text)) throw new Error('connection_anchor_lock_invalid');
            recoveryOwner = Number(text);
          }
          if (!Number.isSafeInteger(recoveryOwner) || recoveryOwner <= 0) throw new Error("connection_anchor_lock_invalid");
          let recoveryOwnerAlive = true;
          if (recoveryOwnerAlive) {
            try { await step(async () => {process.kill(recoveryOwner, 0);}); }
            catch (killError) { if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') throw killError; recoveryOwnerAlive = false; }
          }
          if (!recoveryOwnerAlive) {
            const quarantine = `${recoveryPath}.dead.${randomUUID()}`;
            try {
              await step(() => rename(recoveryPath, quarantine));
              await step(() => rm(quarantine, { recursive: true, force: true }));
            }
            catch (renameError) { if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError; }
          }
        }
        if (Date.now() >= deadline) throw new Error(scope ? 'connection_anchor_busy' : timeoutMessage);
        await step(() => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25)));
      }
    }
  } catch (error) {
    let cleanupFailed = false;
    for (const path of owned.keys()) try {await cleanupOwned(path);} catch {cleanupFailed = true;}
    if (cleanupFailed) throw new Error('connection_anchor_lock_cleanup_unconfirmed');
    if (!scope) throw error;
    await scope.assert();
    if (error instanceof Error && error.message === 'connection_anchor_busy') throw error;
    throw new Error('connection_anchor_lock_unavailable');
  }
}
