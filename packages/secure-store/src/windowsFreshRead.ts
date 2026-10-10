import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

interface Options {
  command: string;
  prefixArgs: string[];
  timeoutMs: number;
  retryAttempts: number;
  idleMs?: number;
}

const script = `
$ErrorActionPreference="Stop";
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false);
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
Add-Type -AssemblyName System.Runtime.WindowsRuntime;
$vault=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new();
while ($null -ne ($line=[Console]::In.ReadLine())) {
  $request=$line | ConvertFrom-Json;
  if ($request.id -lt 1 -or $request.account -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') { exit 1 }
  $credential=$null;
  try {
    $credential=$vault.Retrieve("Dharma Agent Fabric",$request.account);
    $credential.RetrievePassword();
    $response=@{id=$request.id;status=0;value=$credential.Password};
  } catch {
    $status=1;
    if ($_.Exception.GetBaseException().HResult -eq -2147023728) {$status=3}
    $response=@{id=$request.id;status=$status;value=$null}
  }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress));
  [Console]::Out.Flush();
  $credential=$null; $response=$null; $request=$null; $line=$null;
}`;

function failure(code: string) {
  return Object.assign(new Error(`Windows Credential Manager fresh read failed: ${code}.`), { code });
}

// Reuse only the interpreter. Every request retrieves its credential from the OS.
export function createWindowsFreshReader(options: Options) {
  let child: ChildProcessWithoutNullStreams | null = null;
  let buffer = '', decoder = new StringDecoder('utf8'), sequence = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let active: { id: number; accept: (value: string | null) => void;
    reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const reference = (process: ChildProcessWithoutNullStreams, keep: boolean) => {
    for (const handle of [process, process.stdin, process.stdout, process.stderr]) {
      const stream = handle as { ref?: () => void; unref?: () => void };
      if (keep) stream.ref?.(); else stream.unref?.();
    }
  };
  const stop = (error = failure('read_helper_closed')) => {
    clearTimeout(idle);
    idle = undefined;
    const process = child;
    child = null;
    buffer = '';
    if (active) {
      clearTimeout(active.timer);
      active.reject(error);
      active = null;
    }
    process?.kill();
  };
  const start = () => {
    if (child) return child;
    decoder = new StringDecoder('utf8');
    const process = spawn(options.command, [...options.prefixArgs,
      '-NoProfile', '-NonInteractive', '-Command', script],
    { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = process;
    process.stderr.on('data', () => { /* Never forward credential-helper output. */ });
    process.on('error', () => { if (child === process) stop(failure('read_helper_unavailable')); });
    process.on('close', () => { if (child === process) stop(failure('read_helper_exited')); });
    process.stdin.on('error', () => { if (child === process) stop(failure('read_helper_exited')); });
    process.stdout.on('data', (bytes: Buffer) => {
      if (child !== process) return;
      buffer += decoder.write(bytes);
      if (Buffer.byteLength(buffer) > 1_048_576) { stop(failure('read_response_too_large')); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let response: { id?: unknown; status?: unknown; value?: unknown };
      try { response = JSON.parse(line); }
      catch { stop(failure('read_response_invalid')); return; }
      if (!response || !active || buffer.length || response.id !== active.id
        || response.status !== 0 && response.status !== 3
        || response.status === 0 && typeof response.value !== 'string'
        || response.status === 3 && response.value !== null) {
        stop(failure('read_response_invalid')); return;
      }
      const pending = active;
      active = null;
      clearTimeout(pending.timer);
      reference(process, false);
      idle = setTimeout(() => { if (child === process && !active) stop(); }, options.idleMs ?? 30_000);
      idle.unref();
      pending.accept(response.value as string | null);
    });
    return process;
  };
  const readOnce = (account: string) => new Promise<string | null>((accept, reject) => {
    clearTimeout(idle);
    idle = undefined;
    const process = start();
    reference(process, true);
    const id = ++sequence;
    active = { id, accept, reject,
      timer: setTimeout(() => stop(failure('read_timeout')), options.timeoutMs) };
    process.stdin.write(`${JSON.stringify({ id, account })}\n`);
  });
  return {
    read(account: string): Promise<string | null> {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(account)) {
        return Promise.reject(new Error('Invalid secure-store account.'));
      }
      const current = queue.then(async () => {
        for (let attempt = 1; ; attempt += 1) {
          try { return await readOnce(account); }
          catch (error) {
            const code = (error as { code?: string }).code;
            if (attempt >= options.retryAttempts
              || !['read_timeout', 'read_helper_exited'].includes(code ?? '')) throw error;
            await new Promise((accept) => setTimeout(accept, 200 * attempt));
          }
        }
      });
      queue = current.then(() => undefined, () => undefined);
      return current;
    },
    close: () => stop(),
  };
}
