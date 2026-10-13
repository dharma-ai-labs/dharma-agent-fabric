import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute, resolve} from 'node:path';
import {canonicalize, validateContract} from '@dharma-ai-labs/agent-fabric-contracts';

/** One conservative reservation per copied reference. Unsettled exposure is
 * never erased on timeout, cancellation or a lost response. Not an invoice cap. */
export async function reserveCodexSetupLaunch(input: {
  home: string; organizationId: string; setupReference: string; operationId: string;
  promptSha256: string; cents: number; current(): Promise<boolean>;
}): Promise<boolean> {
  input = Object.freeze({home: input.home, organizationId: input.organizationId,
    setupReference: input.setupReference, operationId: input.operationId, promptSha256: input.promptSha256,
    cents: input.cents, current: input.current});
  if (process.platform !== 'linux' || typeof process.getuid !== 'function'
    || !isAbsolute(input.home) || resolve(input.home) !== input.home
    || !Number.isSafeInteger(input.cents) || input.cents < 1 || input.cents > 25
    || !/^org_[A-Za-z0-9]+$/.test(input.organizationId)
    || !/^[a-f0-9]{64}$/.test(input.promptSha256)) return false;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (![input.setupReference, input.operationId].every(value => uuid.test(value))) return false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!await input.current()) return false;
    const home = await lstat(input.home);
    if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid()
      || (home.mode & 0o077) !== 0) return false;
    const payload = {schema: 'dharma.setup-launch-reservation/v1',
      organizationId: input.organizationId, setupReference: input.setupReference, operationId: input.operationId,
      promptSha256: input.promptSha256, reservedProviderCostCents: input.cents,
      reservedAt: new Date().toISOString(), expiresAt: null, actualUsd: null, status: 'UNSETTLED_NOT_RELEASED',
      hardInvoiceCapProven: false};
    const record = {...payload, integrity: {algorithm: 'sha256',
      payloadSha256: createHash('sha256').update(canonicalize(payload)).digest('hex')}};
    if (!(await validateContract(resolve(import.meta.dirname, 'schemas'),
      'https://schemas.dharma-ai.io/setup-launch-reservation/v1', record)).ok || !await input.current()) return false;
    directory = await open(input.home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parent = await directory.stat();
    if (!parent.isDirectory() || parent.uid !== home.uid || parent.dev !== home.dev || parent.ino !== home.ino
      || (parent.mode & 0o077) !== 0) return false;
    const key = createHash('sha256').update(input.organizationId + '\0' + input.setupReference).digest('hex');
    handle = await open(resolve(input.home, 'setup-reservation-' + key + '.json'),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const identity = await handle.stat();
    if (!identity.isFile() || identity.nlink !== 1 || identity.uid !== process.getuid()
      || (identity.mode & 0o077) !== 0) return false;
    await handle.writeFile(JSON.stringify(record) + '\n', 'utf8');
    await handle.sync();
    await directory.sync();
    const currentHome = await lstat(input.home);
    if (!currentHome.isDirectory() || currentHome.isSymbolicLink() || currentHome.dev !== parent.dev
      || currentHome.ino !== parent.ino || currentHome.uid !== parent.uid || (currentHome.mode & 0o077) !== 0) return false;
    return await input.current();
  } catch {return false;}
  finally {
    let failed = false;
    for (const owned of [handle, directory]) {
      try {await owned?.close();} catch {failed = true;}
    }
    if (failed) return false;
  }
}
