import { spawn } from 'node:child_process';

// A desktop opener can run the browser in the foreground (xdg-open on WSL without wslu), so its exit
// is not a signal that the page opened. Count an opener as successful once it spawned and has not
// failed within a short settle window, and leave it running detached from setup.

const SETTLE_MS = 2_000;

function launch(command: string, argv: string[], settleMs: number): Promise<boolean> {
  return new Promise(accept => {
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      accept(opened);
    };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command, argv, { detached: true, stdio: 'ignore', windowsHide: true }); }
    catch { accept(false); return; }
    const timer = setTimeout(() => finish(true), settleMs);
    child.once('error', () => finish(false));
    child.once('exit', code => finish(code === 0));
  });
}

export async function openWithFirstAvailableOpener(attempts: Array<[string, string[]]>,
  options: { settleMs?: number } = {}): Promise<boolean> {
  for (const [command, argv] of attempts) {
    if (await launch(command, argv, options.settleMs ?? SETTLE_MS)) return true;
  }
  return false;
}
