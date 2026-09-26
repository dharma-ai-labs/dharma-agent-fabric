// No-model check of the bounded stdio transport against an installed Codex binary.
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openCodexAppServerTransport } from '../packages/provider-adapters/dist/codexAppServerTransport.js';

const home = await mkdtemp(join(tmpdir(), 'dharma-codex-transport-probe-'));
const windowsCodexJs = join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const windows = process.platform === 'win32';
if (windows && !existsSync(windowsCodexJs)) throw new Error('Installed Codex npm CLI not found');
let transport;
try {
  transport = await openCodexAppServerTransport({
    command: windows ? process.execPath : 'codex',
    argv: windows ? [windowsCodexJs, 'app-server', '--stdio'] : ['app-server', '--stdio'],
    cwd: home,
    environment: { ...process.env, CODEX_HOME: home },
  });
  const profiles = await transport.request('permissionProfile/list', { cwd: home });
  if (!profiles || typeof profiles !== 'object' || !Array.isArray(profiles.data)) {
    throw new Error('permissionProfile/list returned an invalid response');
  }
  const started = await transport.request('thread/start', {
    cwd: home, approvalPolicy: 'never', sandbox: 'read-only',
  });
  const threadId = started?.thread?.id;
  if (typeof threadId !== 'string' || !threadId) throw new Error('thread/start returned no thread ID');
  const read = await transport.request('thread/read', { threadId, includeTurns: false });
  if (read?.thread?.id !== threadId || read.thread.cwd !== home) {
    throw new Error('thread/read returned a different thread or workspace');
  }
  process.stdout.write(`${JSON.stringify({
    status: 'partial', scope: 'disposable_stdio_transport',
    threadReadMatched: true, modelTurnStarted: false, userChatAccessTested: false,
  })}\n`);
} finally {
  await transport?.close();
  const parent = resolve(tmpdir());
  const target = resolve(home);
  if (target.startsWith(`${parent}${sep}`)
    && target.slice(parent.length + 1).startsWith('dharma-codex-transport-probe-')) {
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
