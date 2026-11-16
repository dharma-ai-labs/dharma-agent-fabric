import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Synthetic values only. A skill smoke check started by `dharma skills sync
// --smoke-command` runs through a small launcher that gives the registered command
// operating-system essentials and the names its policy entry lists under
// `environment.inherit`, and nothing else from the CLI environment.
interface SmokeCommandEnvironmentModule {
  smokeCommandPolicy<T extends { tasks: { allowedCommands: Record<string, { argv: string[]; timeoutSeconds: number }> } }>(
    policy: T, commandId: string, launch?: { execPath: string; launcher: string }): T;
  smokeCommandLauncherPath: string;
}

async function smokeModule(): Promise<SmokeCommandEnvironmentModule> {
  const specifier = './smokeCommandEnvironment.js';
  return await import(specifier) as SmokeCommandEnvironmentModule;
}

const launcher = fileURLToPath(new URL('./smokeCommandLauncher.js', import.meta.url));
const ESSENTIALS = new Set((process.platform === 'win32' ? [
  'PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'SystemDrive', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'ProgramData', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
] : [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE',
  'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY', 'TZ', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
]).map(name => name.toUpperCase()));
// Names the platform adds by itself: on Windows, Node's process library adds these to every
// child environment block; on macOS, the system frameworks set the text encoding name at start.
const PLATFORM_PROCESS_NAMES = new Set(process.platform === 'win32'
  ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']
  : process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : []);

function policy() {
  return {
    organizationId: 'org_synthetic',
    tasks: { allowedCommands: {
      smoke: { argv: ['npm', 'run', 'smoke'], timeoutSeconds: 45, environment: { inherit: ['SYNTHETIC_INHERITED'] } },
      plain: { argv: ['npm', 'test'], timeoutSeconds: 30 },
      other: { argv: ['npm', 'run', 'lint'], timeoutSeconds: 60 },
    } },
  };
}

test('the smoke check policy runs the registered command through the environment launcher', async () => {
  const module = await smokeModule();
  const original = policy();
  const before = JSON.stringify(original);
  const wrapped = module.smokeCommandPolicy(original, 'smoke', { execPath: '/synthetic/node', launcher: '/synthetic/launcher.js' });
  assert.equal(JSON.stringify(original), before, 'the approved policy object is not changed');
  assert.deepEqual(wrapped.tasks.allowedCommands.smoke, {
    argv: ['/synthetic/node', '/synthetic/launcher.js', '--timeout-ms', '45000', '--inherit', 'SYNTHETIC_INHERITED', '--',
      'npm', 'run', 'smoke'],
    timeoutSeconds: 45,
    environment: { inherit: ['SYNTHETIC_INHERITED'] },
  });
  assert.deepEqual(wrapped.tasks.allowedCommands.other, original.tasks.allowedCommands.other);
  const plain = module.smokeCommandPolicy(original, 'plain', { execPath: '/synthetic/node', launcher: '/synthetic/launcher.js' });
  assert.deepEqual(plain.tasks.allowedCommands.plain.argv, ['/synthetic/node', '/synthetic/launcher.js', '--timeout-ms', '30000',
    '--', 'npm', 'test']);
  assert.equal(module.smokeCommandLauncherPath, launcher);
});

test('the smoke check policy rejects an unregistered command or an invalid environment entry', async () => {
  const module = await smokeModule();
  assert.throws(() => module.smokeCommandPolicy(policy(), 'missing'), /Command is not registered: missing/);
  const invalid = policy();
  Object.assign(invalid.tasks.allowedCommands.smoke, { environment: { inherit: ['DHARMA_VAULT_KEY'] } });
  assert.throws(() => module.smokeCommandPolicy(invalid, 'smoke'), /invalid environment policy: smoke/);
});

async function launch(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }>((accept, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [launcher, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => accept({ code, stdout, stderr, elapsedMs: Date.now() - started }));
  });
}

test('a smoke check gets operating-system essentials and its inherited names only', async () => {
  const result = await launch(['--timeout-ms', '30000', '--inherit', 'SYNTHETIC_INHERITED', '--', process.execPath, '-e',
    'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], {
    ...process.env,
    SYNTHETIC_INHERITED: 'inherited-value',
    SYNTHETIC_RELAY_ONLY: 'relay-only-value',
    DHARMA_ORG_API_TOKEN: 'synthetic-organization-token',
    DHARMA_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'),
    DHARMA_ALLOW_ENV_KEY: '1',
  });
  assert.equal(result.code, 0, result.stderr);
  const names = (JSON.parse(result.stdout) as string[]).map(name => name.toUpperCase());
  assert.ok(names.includes('SYNTHETIC_INHERITED'));
  assert.ok(names.includes('PATH'));
  const unexpected = names.filter(name => !ESSENTIALS.has(name) && !PLATFORM_PROCESS_NAMES.has(name)
    && name !== 'SYNTHETIC_INHERITED');
  assert.deepEqual(unexpected, []);
});

test('a smoke check keeps its exit status and error output', async () => {
  const result = await launch(['--timeout-ms', '30000', '--', process.execPath, '-e',
    'process.stderr.write("synthetic smoke failure"); process.exit(7)'], process.env);
  assert.equal(result.code, 7);
  assert.equal(result.stderr, 'synthetic smoke failure');
});

test('a smoke check that runs past its timeout is stopped', async () => {
  const result = await launch(['--timeout-ms', '3000', '--', process.execPath, '-e',
    'process.stdout.write("started"); setTimeout(() => {}, 60000)'], process.env);
  assert.equal(result.stdout, 'started', result.stderr);
  assert.notEqual(result.code, 0);
  assert.ok(result.elapsedMs < 20_000, `stopped after ${result.elapsedMs} ms`);
});

// Mirrors how skills sync runs a smoke check: piped output, a stop at exactly the policy
// timeout, and a result only once both pipes close. The launcher starts slowly here (a
// preload that holds the CPU), so its own stop has to count from process start.
test('a smoke check past its timeout is stopped before the caller stops a slow-starting launcher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smoke-launcher-'));
  const preload = join(directory, 'slow-start.cjs');
  await writeFile(preload, 'const end = Date.now() + 2000; while (Date.now() < end) {}\n');
  const timeoutMs = 5000;
  let commandPid: number | undefined;
  try {
    const result = await new Promise<{ closedAfterMs: number; stdout: string; stderr: string }>((accept, reject) => {
      const started = Date.now();
      const child = spawn(process.execPath, ['--require', preload, launcher, '--timeout-ms', String(timeoutMs), '--',
        process.execPath, '-e', 'process.stdout.write(String(process.pid)); setTimeout(() => {}, 20000)'],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        if (/^[0-9]+$/.test(stdout)) commandPid = Number(stdout);
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      const outer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      // Keeps a failing run short: stop the command if the pipes are still open well after the timeout.
      const watchdog = setTimeout(() => { if (commandPid) stopProcess(commandPid); }, timeoutMs + 4000);
      child.once('error', reject);
      child.once('close', () => {
        clearTimeout(outer);
        clearTimeout(watchdog);
        accept({ closedAfterMs: Date.now() - started, stdout, stderr });
      });
    });
    assert.ok(commandPid, `the command started: ${result.stdout} ${result.stderr}`);
    assert.ok(result.closedAfterMs < timeoutMs + 2000, `output closed after ${result.closedAfterMs} ms`);
    assert.equal(processRunning(commandPid!), false, 'the smoke command is not left running');
  } finally {
    if (commandPid && processRunning(commandPid)) stopProcess(commandPid);
    await rm(directory, { recursive: true, force: true });
  }
});

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already stopped
  }
}

test('the smoke launcher refuses malformed arguments without starting anything', async () => {
  for (const args of [[], ['--', process.execPath], ['--timeout-ms', '0', '--', process.execPath],
    ['--timeout-ms', '1000', '--inherit', 'DHARMA_ORG_API_TOKEN', '--', process.execPath],
    ['--timeout-ms', '1000', '--'], ['--timeout-ms', '1000', '--unknown', '--', process.execPath]]) {
    const result = await launch(args, process.env);
    assert.equal(result.code, 2, `${JSON.stringify(args)}: ${result.stderr}`);
  }
});

test('skills sync passes installSkillBundle the launcher-wrapped policy only for a smoke check', async () => {
  const source = (await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = source.indexOf('const receipt = await installSkillBundle({');
  assert.ok(start > 0);
  const call = source.slice(start, source.indexOf('\n    });', start));
  assert.match(call, /\n\s+policy: smokeCommandId \? smokeCommandPolicy\(policy, smokeCommandId\) : policy,\n/);
  assert.match(call, /\n\s+smokeCommandId,\n/);
});
