import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export interface SecureSecretStore {
  backend: 'windows-credential-manager' | 'macos-keychain' | 'linux-secret-service';
  get(account: string): Promise<string | null>;
  put(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

function processCachedStore(store: SecureSecretStore): SecureSecretStore {
  const values = new Map<string, string>();
  const pending = new Map<string, Promise<string | null>>();
  return {
    backend: store.backend,
    async get(account) {
      if (values.has(account)) return values.get(account)!;
      const current = pending.get(account);
      if (current) return current;
      const request = store.get(account).then((value) => {
        if (value !== null) values.set(account, value);
        return value;
      }).finally(() => pending.delete(account));
      pending.set(account, request);
      return request;
    },
    async put(account, secret) {
      await store.put(account, secret);
      values.set(account, secret);
    },
    async delete(account) {
      await store.delete(account);
      values.delete(account);
    },
  };
}

let systemStore: SecureSecretStore | null = null;

interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean }

function run(command: string, argv: string[], input?: string, timeoutMs = 10_000): Promise<ProcessResult> {
  return new Promise((accept, reject) => {
    const child = spawn(command, argv, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      accept(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        code: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `Secure-store command timed out after ${timeoutMs} ms.`,
        timedOut: true,
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => finish({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function isTransientWindowsInteropFailure(result: ProcessResult) {
  return result.timedOut === true
    || /UtilAcceptVsock|accept4 failed 110|ECONNRESET|resource temporarily unavailable/i.test(result.stderr);
}

async function withTransientWindowsRetry(
  operation: () => Promise<ProcessResult>,
  options: { attempts?: number; delayMs?: number } = {},
) {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = Math.max(0, options.delayMs ?? 200);
  let result: ProcessResult | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await operation();
    if (!isTransientWindowsInteropFailure(result) || attempt === attempts) return result;
    await new Promise((accept) => setTimeout(accept, delayMs * attempt));
  }
  return result!;
}

function assertAccount(account: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(account)) throw new Error('Invalid secure-store account.');
}

const windowsPreamble = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Runtime.WindowsRuntime; $vault=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new(); ';
const windowsRead = `${windowsPreamble}try {$credential=$vault.Retrieve("Dharma Agent Fabric",$args[0]); $credential.RetrievePassword(); [Console]::Out.Write($credential.Password)} catch {exit 3}`;
const windowsWrite = `${windowsPreamble}$value=[Console]::In.ReadToEnd(); try {$old=$vault.Retrieve("Dharma Agent Fabric",$args[0]); $vault.Remove($old)} catch {}; $credential=[Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]::new("Dharma Agent Fabric",$args[0],$value); $vault.Add($credential)`;
const windowsDelete = `${windowsPreamble}try {$credential=$vault.Retrieve("Dharma Agent Fabric",$args[0]); $vault.Remove($credential)} catch {exit 3}`;

interface WindowsCommandSpec {
  command: string;
  prefixArgs: string[];
  timeoutMs: number;
  retryAttempts: number;
}

function windowsCommandSpec(platform = process.platform): WindowsCommandSpec {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      prefixArgs: [],
      timeoutMs: 5_000,
      retryAttempts: 3,
    };
  }
  return {
    command: '/init',
    prefixArgs: ['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'],
    // WSL cold-start and WinRT activation routinely exceed five seconds.
    // Keep the bridge bounded while allowing one transient retry.
    timeoutMs: 15_000,
    retryAttempts: 2,
  };
}

function windowsStore(command?: string, commandSpecOverride?: WindowsCommandSpec): SecureSecretStore {
  const commandSpec = commandSpecOverride ?? (command
    ? { command, prefixArgs: [], timeoutMs: 5_000, retryAttempts: 3 }
    : windowsCommandSpec());
  const invoke = (script: string, account: string, secret?: string) => withTransientWindowsRetry(
    () => run(commandSpec.command, [
      ...commandSpec.prefixArgs,
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `& { ${script} }`,
      account,
    ], secret, commandSpec.timeoutMs),
    { attempts: commandSpec.retryAttempts },
  );
  return {
    backend: 'windows-credential-manager',
    async get(account) {
      assertAccount(account);
      const result = await invoke(windowsRead, account);
      if (result.code === 3) return null;
      if (result.code !== 0) throw new Error(`Windows Credential Manager failed: ${result.stderr.trim()}`);
      return result.stdout;
    },
    async put(account, secret) {
      assertAccount(account);
      const result = await invoke(windowsWrite, account, secret);
      if (result.code !== 0) throw new Error(`Windows Credential Manager failed: ${result.stderr.trim()}`);
    },
    async delete(account) {
      assertAccount(account);
      const result = await invoke(windowsDelete, account);
      if (result.code !== 0 && result.code !== 3) throw new Error(`Windows Credential Manager failed: ${result.stderr.trim()}`);
    },
  };
}

function linuxStore(): SecureSecretStore {
  return {
    backend: 'linux-secret-service',
    async get(account) {
      assertAccount(account);
      const result = await run('secret-tool', ['lookup', 'service', 'dharma-agent-fabric', 'account', account]);
      if (result.code === 1) return null;
      if (result.code !== 0) throw new Error(`Linux Secret Service failed: ${result.stderr.trim()}`);
      return result.stdout.trimEnd();
    },
    async put(account, secret) {
      assertAccount(account);
      const result = await run('secret-tool', ['store', '--label=Dharma Agent Fabric', 'service', 'dharma-agent-fabric', 'account', account], secret);
      if (result.code !== 0) throw new Error(`Linux Secret Service failed: ${result.stderr.trim()}`);
    },
    async delete(account) {
      assertAccount(account);
      const result = await run('secret-tool', ['clear', 'service', 'dharma-agent-fabric', 'account', account]);
      if (result.code !== 0 && result.code !== 1) throw new Error(`Linux Secret Service failed: ${result.stderr.trim()}`);
    },
  };
}

function macosStore(): SecureSecretStore {
  return {
    backend: 'macos-keychain',
    async get(account) {
      assertAccount(account);
      const result = await run('security', ['find-generic-password', '-s', 'Dharma Agent Fabric', '-a', account, '-w']);
      if (result.code === 44) return null;
      if (result.code !== 0) throw new Error(`macOS Keychain failed: ${result.stderr.trim()}`);
      return result.stdout.trimEnd();
    },
    async put(account, secret) {
      assertAccount(account);
      const result = await run('security', ['add-generic-password', '-U', '-s', 'Dharma Agent Fabric', '-a', account, '-w', secret]);
      if (result.code !== 0) throw new Error(`macOS Keychain failed: ${result.stderr.trim()}`);
    },
    async delete(account) {
      assertAccount(account);
      const result = await run('security', ['delete-generic-password', '-s', 'Dharma Agent Fabric', '-a', account]);
      if (result.code !== 0 && result.code !== 44) throw new Error(`macOS Keychain failed: ${result.stderr.trim()}`);
    },
  };
}

async function isWsl(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try { return /microsoft|wsl/i.test(await readFile('/proc/version', 'utf8')); } catch { return false; }
}

export async function createSystemSecureStore(): Promise<SecureSecretStore> {
  if (systemStore) return systemStore;
  if (process.platform === 'win32') systemStore = processCachedStore(windowsStore());
  else if (process.platform === 'darwin') systemStore = processCachedStore(macosStore());
  else if (await isWsl()) systemStore = processCachedStore(windowsStore());
  else if (process.platform === 'linux') systemStore = processCachedStore(linuxStore());
  if (systemStore) return systemStore;
  throw new Error(`No supported secure secret store for ${process.platform}.`);
}

export const secureStoreInternals = {
  run,
  windowsCommandSpec,
  isTransientWindowsInteropFailure,
  withTransientWindowsRetry,
  processCachedStore,
  windowsStore,
  linuxStore,
  macosStore,
};
