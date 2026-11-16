// Starts one registered skill smoke command with the explicit command environment:
// operating-system essentials and the names given with --inherit, nothing else.
//
//   node smokeCommandLauncher.js --timeout-ms <n> [--inherit NAME]... -- <argv...>
//
// The command's exit status and error output pass through unchanged. The command is
// stopped shortly before the caller's own timeout so that it does not outlive this launcher.
import { spawn } from 'node:child_process';
import { registeredCommandEnvironment } from '@dharma-ai-labs/agent-fabric-task-runner';

const USAGE = 'usage: smokeCommandLauncher --timeout-ms <n> [--inherit NAME]... -- <command> [arguments...]';

function parse(args: string[]): { timeoutMs: number; inherit: string[]; argv: string[] } | null {
  let timeoutMs: number | undefined;
  const inherit: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--') {
      const argv = args.slice(index + 1);
      return timeoutMs === undefined || argv.length === 0 ? null : { timeoutMs, inherit, argv };
    }
    const value = args[index + 1];
    if (value === undefined) return null;
    if (flag === '--timeout-ms' && timeoutMs === undefined && /^[1-9][0-9]{0,8}$/.test(value)) timeoutMs = Number(value);
    else if (flag === '--inherit') inherit.push(value);
    else return null;
    index += 1;
  }
  return null;
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

const parsed = parse(process.argv.slice(2));
if (!parsed) fail(USAGE);
else {
  let environment: Record<string, string> | undefined;
  try {
    environment = registeredCommandEnvironment({ source: process.env, platform: process.platform,
      command: parsed.inherit.length ? { environment: { inherit: parsed.inherit } } : {}, commandId: 'smoke command' });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (environment) {
    const [executable, ...argv] = parsed.argv;
    const child = spawn(executable!, argv, { cwd: process.cwd(), shell: false, windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'], env: environment });
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1, parsed.timeoutMs - 500));
    let failed = false;
    child.once('error', (error) => {
      failed = true;
      clearTimeout(timer);
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (!failed) process.exitCode = code ?? 1;
    });
  }
}
