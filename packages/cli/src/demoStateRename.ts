import { rename } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

export interface DemoStateRenameDependencies {
  rename?: (source: string, destination: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

export async function renameDemoStateFile(source: string, destination: string,
  deps: DemoStateRenameDependencies = {}): Promise<void> {
  const renameFile = deps.rename ?? rename;
  const sleep = deps.sleep ?? (async milliseconds => { await setTimeout(milliseconds); });
  const platform = deps.platform ?? process.platform;
  for (let attempt = 0; ; attempt++) {
    try { await renameFile(source, destination); return; }
    catch (error) {
      const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 5) throw error;
      // Keep the prepared bytes and current destination; retry only the atomic swap.
      await sleep(25 * 2 ** attempt);
    }
  }
}
