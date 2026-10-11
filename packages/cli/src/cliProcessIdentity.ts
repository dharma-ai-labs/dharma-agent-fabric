import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, realpath, stat} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readContainerProcessIdentity, verifyContainerControllerRuntime,
  type ContainerProcessIdentity} from './containerRelayLifecycle.js';

const executableHashes = new Map<string, Promise<string>>();
async function publicExecutableHash(path: string, uid: number) {
  const canonical = await realpath(path);
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    const mapped = await stat(path);
    if (!before.isFile() || ![0, uid].includes(before.uid) || (before.mode & 0o022) !== 0
      || before.size < 1 || before.size > 268_435_456 || before.dev !== mapped.dev || before.ino !== mapped.ino) {
      throw new Error('cli_process_unverified');
    }
    const fingerprint = JSON.stringify([canonical, before.dev, before.ino, before.uid, before.mode,
      before.size, before.mtimeMs, before.ctimeMs]);
    let digest = executableHashes.get(fingerprint);
    if (!digest) {
      digest = (async () => {
        const hash = createHash('sha256');
        for await (const chunk of file.createReadStream({autoClose: false})) hash.update(chunk);
        return hash.digest('hex');
      })();
      if (executableHashes.size >= 16) executableHashes.clear();
      executableHashes.set(fingerprint, digest);
      digest.catch(() => executableHashes.delete(fingerprint));
    }
    const result = await digest;
    const after = await file.stat();
    if (JSON.stringify([after.dev, after.ino, after.uid, after.mode, after.size, after.mtimeMs, after.ctimeMs])
      !== JSON.stringify([before.dev, before.ino, before.uid, before.mode, before.size, before.mtimeMs, before.ctimeMs])) {
      executableHashes.delete(fingerprint);
      throw new Error('cli_process_unverified');
    }
    return result;
  } finally {await file.close();}
}

export async function matchingCliExecutable(pid: number, caller: string, uid: number) {
  if (await realpath(caller) !== await realpath('/proc/self/exe')) return false;
  const [running, trusted] = await Promise.all([
    publicExecutableHash(`/proc/${pid}/exe`, uid), publicExecutableHash('/proc/self/exe', uid),
  ]);
  return running === trusted;
}

interface ProcessVerification {
  uid?: number;
  execPath?: string;
  identity?(pid: number): Promise<ContainerProcessIdentity>;
  resolve?(path: string): Promise<string>;
  executableMatches?(pid: number, caller: string, uid: number): Promise<boolean>;
  verifyRuntime?(candidate: string, caller: string): Promise<string>;
}

/** Normalize npm aliases only after verifying the live executable and exact
 * published CLI bytes. Callers still enforce their complete action/flag tuple. */
export async function verifiedCliProcessArguments(identity: ContainerProcessIdentity, callerIndex: string,
  runtime: ProcessVerification = {}): Promise<string[] | null> {
  try {
    const uid = runtime.uid ?? process.getuid?.() ?? -1, execPath = runtime.execPath ?? process.execPath;
    const readIdentity = runtime.identity ?? readContainerProcessIdentity;
    const resolve = runtime.resolve ?? realpath;
    const executableMatches = runtime.executableMatches ?? matchingCliExecutable;
    const verifyRuntime = runtime.verifyRuntime ?? (async (candidate: string, caller: string) => {
      const verified = await verifyContainerControllerRuntime(candidate, caller);
      const [installedGuard, callerGuard] = await Promise.all([
        publicExecutableHash(join(dirname(candidate), 'cliProcessIdentity.js'), uid),
        publicExecutableHash(join(dirname(caller), 'cliProcessIdentity.js'), uid),
      ]);
      if (installedGuard !== callerGuard) throw new Error('cli_process_unverified');
      return verified;
    });
    if (uid <= 0 || identity.uid !== uid || !Number.isSafeInteger(identity.pid) || identity.pid < 1
      || !/^\d{1,20}$/.test(identity.startTicks) || identity.argv.length < 2) return null;
    if (JSON.stringify(await readIdentity(identity.pid)) !== JSON.stringify(identity)) return null;
    const command = identity.argv[0]!, script = identity.argv[1]!;
    if ((command !== 'node' && !isAbsolute(command)) || !isAbsolute(script) || script.length > 4096
      || /[\r\n\0]/.test(script)) return null;
    const executable = await resolve(`/proc/${identity.pid}/exe`);
    if (command !== 'node' && await resolve(command) !== executable) return null;
    if (!await executableMatches(identity.pid, execPath, uid)) return null;
    const entrypoint = await resolve(script), kind = basename(entrypoint);
    if (!['bin.js', 'index.js'].includes(kind) || basename(dirname(entrypoint)) !== 'dist') return null;
    const ownIndex = fileURLToPath(callerIndex), ownBin = join(dirname(ownIndex), 'bin.js');
    const candidateBin = join(dirname(entrypoint), 'bin.js');
    if (await verifyRuntime(candidateBin, ownBin) !== candidateBin) return null;
    if (await resolve(script) !== entrypoint || await resolve(`/proc/${identity.pid}/exe`) !== executable
      || JSON.stringify(await readIdentity(identity.pid)) !== JSON.stringify(identity)) return null;
    return [execPath, join(dirname(ownIndex), kind), ...identity.argv.slice(2)];
  } catch {return null;}
}
