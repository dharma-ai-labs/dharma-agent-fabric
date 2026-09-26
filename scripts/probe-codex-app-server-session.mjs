// Read-only protocol probe. It creates and resumes a disposable Codex thread without a model turn.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

const windowsCodexJs = join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
if (process.platform === 'win32' && !existsSync(windowsCodexJs)) {
  throw new Error('The installed Codex npm CLI could not be found.');
}
const home = await mkdtemp(join(tmpdir(), 'dharma-codex-session-probe-'));
const command = process.platform === 'win32' ? process.execPath : 'codex';
const argv = process.platform === 'win32'
  ? [windowsCodexJs, 'app-server', '--stdio'] : ['app-server', '--stdio'];
const child = spawn(command, argv, {
  cwd: home,
  env: { ...process.env, CODEX_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
const pending = new Map();
let nextId = 1;
let diagnostic = '';
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let response;
  try { response = JSON.parse(line); } catch { return; }
  const entry = pending.get(response.id);
  if (!entry) return;
  pending.delete(response.id);
  clearTimeout(entry.timer);
  if (response.error) entry.reject(new Error(`app-server ${entry.method}: ${response.error.message}`));
  else entry.resolve(response.result);
});
child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2_000); });
child.on('error', error => {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
  pending.clear();
});
child.on('exit', code => {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(`app-server exited ${code}: ${diagnostic}`));
  }
  pending.clear();
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`app-server ${method} timed out`));
    }, 15_000);
    pending.set(id, { method, resolve: resolveResult, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

try {
  await request('initialize', {
    clientInfo: { name: 'dharma-session-probe', title: 'Dharma Session Probe', version: '0.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const started = await request('thread/start', { cwd: home, approvalPolicy: 'never', sandbox: 'read-only' });
  const threadId = started?.thread?.id;
  if (typeof threadId !== 'string' || !threadId) throw new Error('thread/start returned no thread ID');
  let resumeDisposition = 'persisted';
  try {
    const resumed = await request('thread/resume', { threadId });
    if (resumed?.thread?.id !== threadId) throw new Error('thread/resume returned another thread');
  } catch (error) {
    if (!/no rollout found/i.test(error.message)) throw error;
    resumeDisposition = 'not_persisted_before_first_turn';
  }
  process.stdout.write(`${JSON.stringify({
    status: 'partial', scope: 'disposable_thread_start_resume', resumeDisposition,
    modelTurnStarted: false, activeDesktopChatTested: false,
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  const graceful = await Promise.race([closed.then(() => true), new Promise(resolveWait => setTimeout(() => resolveWait(false), 5_000))]);
  if (!graceful) { child.kill(); await closed; }
  const parent = resolve(tmpdir());
  const target = resolve(home);
  if (target.startsWith(`${parent}${sep}`) && target.slice(parent.length + 1).startsWith('dharma-codex-session-probe-')) {
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
